const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validateBackup, inspectRecords } = require('./biometricBackup');
const { enrollmentError } = require('./zkEnrollment');

const scrypt = promisify(crypto.scrypt);
const MAX_ARCHIVE = 16 * 1024 * 1024;
const AAD = Buffer.from('asisto-biometric-backup:2');

function passwordValue(value) {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value) > 256) throw enrollmentError('La contrasena del respaldo debe tener entre 12 caracteres y 256 bytes.', 400);
  return value;
}

function base64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4) throw enrollmentError('Archivo de respaldo invalido o demasiado grande.', 400);
  const data = Buffer.from(value, 'base64');
  if (data.length > limit || data.toString('base64') !== value) throw enrollmentError('Archivo de respaldo invalido.', 400);
  return data;
}

async function passwordKey(password, salt) {
  return scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function encryptArchive(payload, password) {
  passwordValue(password);
  validateBackup(payload);
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const key = await passwordKey(password, salt);
  const plain = Buffer.from(JSON.stringify(payload));
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const archive = Buffer.from(JSON.stringify({ format: 'asisto-biometric-backup', version: 2,
      encryption: 'AES-256-GCM+SCRYPT', kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64') },
      nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    if (archive.length > MAX_ARCHIVE) throw enrollmentError('El respaldo supera el limite de 16 MB.', 413);
    return archive;
  } finally { key.fill(0); plain.fill(0); }
}

async function decryptArchive(encoded, password) {
  passwordValue(password);
  const archive = base64(encoded, MAX_ARCHIVE);
  let envelope;
  try { envelope = JSON.parse(archive.toString('utf8')); }
  catch { throw enrollmentError('El archivo no es un respaldo ASISTO valido.', 400); }
  if (envelope.version === 1) throw enrollmentError('Este respaldo RSA requiere la herramienta de claves privadas. Importe un respaldo descargado desde ASISTO con contrasena.', 422);
  const kdf = envelope.kdf;
  if (envelope.format !== 'asisto-biometric-backup' || envelope.version !== 2 || envelope.encryption !== 'AES-256-GCM+SCRYPT' ||
      kdf?.name !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1) throw enrollmentError('Formato o cifrado de respaldo no compatible.', 422);
  const salt = base64(kdf.salt, 16), nonce = base64(envelope.nonce, 12), tag = base64(envelope.tag, 16);
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16) throw enrollmentError('Parametros de respaldo invalidos.', 400);
  const ciphertext = base64(envelope.ciphertext, MAX_ARCHIVE);
  const key = await passwordKey(password, salt);
  let partial, plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    partial = decipher.update(ciphertext);
    plain = Buffer.concat([partial, decipher.final()]);
    try {
      const payload = JSON.parse(plain.toString('utf8'));
      validateBackup(payload);
      return payload;
    } catch {
      const error = enrollmentError('El archivo se descifro, pero sus datos internos no son un respaldo valido. No se realizo ninguna carga al reloj.', 400);
      error.code = 'BACKUP_CONTENT_INVALID';
      throw error;
    }
  } catch (error) {
    if (error.code === 'BACKUP_CONTENT_INVALID') throw error;
    const safe = enrollmentError('La contrasena no permite abrir este archivo o el contenido cifrado fue alterado. No se realizo ninguna carga al reloj.', 400);
    safe.code = 'BACKUP_AUTH_FAILED';
    throw safe;
  }
  finally { key.fill(0); partial?.fill(0); plain?.fill(0); }
}

function archiveIndex(payload) {
  validateBackup(payload);
  const users = Buffer.from(payload.records.users, 'base64');
  const fingers = Buffer.from(payload.records.templates, 'base64');
  const employees = [];
  const userHashes = new Map();
  try {
    const { templates } = inspectRecords(users, fingers);
    for (let offset = 4; offset < users.length; offset += 72) {
      const record = users.subarray(offset, offset + 72);
      const uid = record.readUInt16LE(0);
      const slots = [];
      let valid = true;
      for (let start = 4; start < fingers.length; start += fingers.readUInt16LE(start)) {
        if (fingers.readUInt16LE(start + 2) === uid) { slots.push(fingers[start + 4]); valid &&= fingers[start + 5] === 1; }
      }
      userHashes.set(uid, crypto.createHash('sha256').update(record).digest('hex'));
      employees.push({ uid, employeeId: record.subarray(48).toString('utf8').split('\0')[0],
        name: record.subarray(11, 35).toString('utf8').split('\0')[0], role: record[2], fingers: slots.sort((a, b) => a - b), valid });
    }
    assert.equal(employees.length, userHashes.size);
    return { employees, userHashes, templates };
  } finally { users.fill(0); fingers.fill(0); }
}

module.exports = { MAX_ARCHIVE, passwordValue, encryptArchive, decryptArchive, archiveIndex };
