const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { REQUEST_DATA } = require('zklib-js/constants');
const { readTcpPreparedData, validateRecordBuffer } = require('./zkTcpDownload');
const { readEnrollmentSnapshot } = require('./zkEnrollment');
const { indexFingerprintRecords } = require('./zkFingerprintRecords');

const FORMAT = 'asisto-biometric-backup';
const MAX_BYTES = 64 * 1024 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function inspectRecords(usersData, templatesData) {
  assert.ok(usersData.length <= MAX_BYTES && templatesData.length <= MAX_BYTES, 'Respaldo demasiado grande.');
  const users = validateRecordBuffer(usersData, 72);
  const uids = new Set();
  const employeeIds = new Set();
  for (let offset = 0; offset < users.length; offset += 72) {
    const uid = users.readUInt16LE(offset);
    const employeeId = users.subarray(offset + 48, offset + 72).toString('utf8').split('\0')[0];
    assert.ok(uid > 0 && employeeId && !uids.has(uid) && !employeeIds.has(employeeId), 'Usuario invalido o duplicado en el respaldo.');
    uids.add(uid);
    employeeIds.add(employeeId);
  }
  const { templates, recordCount, owners } = indexFingerprintRecords(templatesData, uids);
  return {
    templates,
    manifest: {
      usersCount: uids.size, templatesCount: recordCount, usersWithTemplates: owners.size,
      usersBytes: usersData.length, templatesBytes: templatesData.length,
      usersSha256: hash(usersData), templatesSha256: hash(templatesData),
    },
  };
}

function sameTemplates(left, right) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

async function captureBackup(device, identity, options = {}) {
  const snapshot = options.snapshot || readEnrollmentSnapshot;
  const download = options.download || readTcpPreparedData;
  const serial = String(await device.getSerialNumber()).replace(/\0/g, '').trim();
  assert.ok(identity.serial && serial === identity.serial, 'El numero de serie no coincide con el equipo autorizado.');
  const firmware = String(await device.getFirmware()).replace(/\0/g, '').trim();
  const model = String(await device.getDeviceName()).replace(/\0/g, '').trim();
  const before = await snapshot(device);
  let usersData;
  let templatesData;
  try {
    await device.zklibTcp.freeData();
    usersData = await download(device.zklibTcp, REQUEST_DATA.GET_USERS);
    await device.zklibTcp.freeData();
    const request = Buffer.alloc(11);
    request[0] = 1;
    request.writeUInt16LE(7, 1);
    request.writeUInt32LE(2, 3);
    templatesData = await download(device.zklibTcp, request);
    await device.zklibTcp.freeData();
    const { manifest, templates } = inspectRecords(usersData, templatesData);
    assert.equal(manifest.usersSha256, before.usersHash, 'Los usuarios cambiaron durante el respaldo. Reintente.');
    assert.equal(manifest.usersCount, before.users.length, 'El respaldo de usuarios esta incompleto.');
    assert.ok(sameTemplates(templates, before.templates), 'Las huellas cambiaron durante el respaldo. Reintente.');
    const after = await snapshot(device);
    assert.ok(before.usersHash === after.usersHash && sameTemplates(before.templates, after.templates), 'El reloj cambio durante la verificacion. No se guardara un respaldo inconsistente.');
    return {
      format: FORMAT, version: 1, createdAt: new Date().toISOString(),
      device: { ...identity, serial, model, firmware },
      records: { users: usersData.toString('base64'), templates: templatesData.toString('base64') },
      manifest, sourceVerifiedUnchanged: true, restorationTested: false,
    };
  } finally {
    usersData?.fill(0);
    templatesData?.fill(0);
  }
}

function decodeBase64(value, limit = MAX_BYTES) {
  assert.ok(typeof value === 'string' && value.length <= Math.ceil(limit / 3) * 4, 'Codificacion de respaldo invalida.');
  const buffer = Buffer.from(value, 'base64');
  assert.ok(buffer.length <= limit && buffer.toString('base64') === value, 'Codificacion de respaldo invalida o demasiado grande.');
  return buffer;
}

function validateBackup(payload) {
  assert.ok(payload?.format === FORMAT && payload.version === 1 && payload.device?.serial, 'Formato de respaldo no compatible.');
  const users = decodeBase64(payload.records?.users);
  let templates;
  try {
    templates = decodeBase64(payload.records?.templates);
    const { manifest } = inspectRecords(users, templates);
    assert.deepEqual(payload.manifest, manifest, 'La integridad del respaldo no coincide.');
    return manifest;
  } finally { users.fill(0); templates?.fill(0); }
}

function encryptBackup(payload, publicKeyPem, options = {}) {
  validateBackup(payload);
  const publicKey = crypto.createPublicKey(publicKeyPem);
  assert.ok(publicKey.asymmetricKeyType === 'rsa' && publicKey.asymmetricKeyDetails.modulusLength >= 3072, 'Use una clave RSA de al menos 3072 bits.');
  const version = options.keyId ? 3 : 1;
  if (version === 3) assert.match(options.keyId, /^[a-f0-9]{64}$/);
  const aad = `${FORMAT}:${version}${version === 3 ? ':' + options.keyId : ''}`;
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(payload));
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, key);
    return Buffer.from(JSON.stringify({
      format: FORMAT, version, encryption: 'RSA-OAEP-SHA256+AES-256-GCM', ...(version === 3 && { keyId: options.keyId }),
      key: wrappedKey.toString('base64'), nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64'),
    }));
  } finally { key.fill(0); plaintext.fill(0); }
}

function decryptBackup(encrypted, privateKeyPem) {
  assert.ok(encrypted.length <= 256 * 1024 * 1024, 'Archivo de respaldo demasiado grande.');
  const envelope = JSON.parse(encrypted.toString('utf8'));
  assert.ok(envelope.format === FORMAT && [1, 3].includes(envelope.version) && envelope.encryption === 'RSA-OAEP-SHA256+AES-256-GCM', 'Cifrado de respaldo no compatible.');
  if (envelope.version === 3) assert.match(envelope.keyId, /^[a-f0-9]{64}$/);
  const nonce = decodeBase64(envelope.nonce, 12);
  const tag = decodeBase64(envelope.tag, 16);
  assert.ok(nonce.length === 12 && tag.length === 16, 'Parametros de cifrado invalidos.');
  const key = crypto.privateDecrypt({ key: privateKeyPem, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, decodeBase64(envelope.key, 1024));
  let plaintext;
  let partial;
  try {
    assert.equal(key.length, 32, 'Clave de cifrado invalida.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(`${FORMAT}:${envelope.version}${envelope.version === 3 ? ':' + envelope.keyId : ''}`));
    decipher.setAuthTag(tag);
    partial = decipher.update(decodeBase64(envelope.ciphertext, 192 * 1024 * 1024));
    plaintext = Buffer.concat([partial, decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    validateBackup(payload);
    return payload;
  } finally { key.fill(0); partial?.fill(0); plaintext?.fill(0); }
}

function backupSummary(payload) {
  return {
    device: payload.device, createdAt: payload.createdAt,
    users: payload.manifest.usersCount, fingerprints: payload.manifest.templatesCount,
    usersWithFingerprints: payload.manifest.usersWithTemplates,
    sourceVerifiedUnchanged: payload.sourceVerifiedUnchanged === true,
    restorationTested: false,
  };
}

module.exports = { inspectRecords, captureBackup, validateBackup, encryptBackup, decryptBackup, backupSummary };
