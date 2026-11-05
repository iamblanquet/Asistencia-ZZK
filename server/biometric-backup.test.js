const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectRecords, captureBackup, validateBackup, encryptBackup, decryptBackup, backupSummary } = require('./services/biometricBackup');
const { writePrivateFile } = require('./biometric-backup');

const pair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function records() {
  const users = Buffer.alloc(4 + 72 * 2);
  users.writeUInt32LE(users.length - 4);
  for (const [index, uid, id, name] of [[0, 1, '52', 'Test user'], [1, 2, '56', 'No fingerprint']]) {
    const offset = 4 + index * 72;
    users.writeUInt16LE(uid, offset);
    users.write(name, offset + 11, 24);
    users.write(id, offset + 48, 24);
  }
  const templates = Buffer.alloc(4 + 6 + 12);
  templates.writeUInt32LE(templates.length - 4);
  templates.writeUInt16LE(18, 4);
  templates.writeUInt16LE(1, 6);
  templates[8] = 3;
  templates[9] = 1;
  templates.write('FAKE-PRINT!!', 10);
  return { users, templates };
}

function payload() {
  const { users, templates } = records();
  return {
    format: 'asisto-biometric-backup', version: 1, createdAt: '2026-11-04T15:00:00.000Z',
    device: { serial: 'TEST-SERIAL', model: 'F22', ip: '192.0.2.1' },
    records: { users: users.toString('base64'), templates: templates.toString('base64') },
    manifest: inspectRecords(users, templates).manifest, sourceVerifiedUnchanged: true, restorationTested: false,
  };
}

test('validates exact raw user records, templates and their owner/finger association', () => {
  const { users, templates } = records();
  const result = inspectRecords(users, templates);
  assert.equal(result.manifest.usersCount, 2);
  assert.equal(result.manifest.templatesCount, 1);
  assert.equal(result.manifest.usersWithTemplates, 1);
  assert.ok(result.templates.has('1:3'));
});

test('rejects truncated downloads, orphan templates, invalid fingers and duplicate users', () => {
  const { users, templates } = records();
  assert.throws(() => inspectRecords(users.subarray(0, -1), templates));
  assert.throws(() => inspectRecords(users, templates.subarray(0, -1)));
  const orphan = Buffer.from(templates); orphan.writeUInt16LE(999, 6);
  assert.throws(() => inspectRecords(users, orphan));
  const finger = Buffer.from(templates); finger[8] = 10;
  assert.throws(() => inspectRecords(users, finger));
  const duplicate = Buffer.from(users); duplicate.writeUInt16LE(1, 76);
  assert.throws(() => inspectRecords(duplicate, templates));
});

test('encrypted backup round-trips the original bytes without exposing users or templates', () => {
  const original = payload();
  const encrypted = encryptBackup(original, pair.publicKey);
  assert.deepEqual(decryptBackup(encrypted, pair.privateKey), original);
  assert.ok(!encrypted.toString().includes('Test user'));
  assert.ok(!encrypted.toString().includes(original.records.templates));
  assert.equal(backupSummary(original).restorationTested, false);
  assert.equal(backupSummary(original).records, undefined);
});

test('rejects tampering with ciphertext, key, nonce, tag, version or algorithm', () => {
  const envelope = JSON.parse(encryptBackup(payload(), pair.publicKey));
  for (const field of ['ciphertext', 'key', 'nonce', 'tag']) {
    const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1;
    assert.throws(() => decryptBackup(Buffer.from(JSON.stringify({ ...envelope, [field]: bytes.toString('base64') })), pair.privateKey));
  }
  assert.throws(() => decryptBackup(Buffer.from(JSON.stringify({ ...envelope, version: 2 })), pair.privateKey));
  assert.throws(() => decryptBackup(Buffer.from(JSON.stringify({ ...envelope, encryption: 'none' })), pair.privateKey));
});

test('rejects another private key and damaged manifests', () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  assert.throws(() => decryptBackup(encryptBackup(payload(), pair.publicKey), other.privateKey));
  const damaged = payload(); damaged.manifest.templatesCount++;
  assert.throws(() => validateBackup(damaged));
  assert.throws(() => validateBackup({ ...payload(), records: { users: '*', templates: '' } }));
});

function captureFixture({ changed = false, failDownload = false, wrongSerial = false } = {}) {
  const { users, templates } = records();
  const inspected = inspectRecords(users, templates);
  const snapshot = { users: [{}, {}], usersHash: inspected.manifest.usersSha256, templates: inspected.templates };
  let snapshots = 0, downloads = 0;
  const device = {
    getSerialNumber: async () => wrongSerial ? 'OTHER' : 'TEST-SERIAL',
    getFirmware: async () => 'TEST-FIRMWARE', getDeviceName: async () => 'F22',
    zklibTcp: { freeData: async () => {} },
  };
  const options = {
    snapshot: async () => ++snapshots === 2 && changed ? { ...snapshot, templates: new Map() } : snapshot,
    download: async () => { if (failDownload && downloads === 1) throw new Error('offline'); return downloads++ === 0 ? users : templates; },
  };
  return { device, options, users, templates, run: () => captureBackup(device, { serial: 'TEST-SERIAL' }, options) };
}

test('read-only capture checks both snapshots, preserves raw bytes and wipes download buffers', async () => {
  const fixture = captureFixture();
  const expected = records();
  const result = await fixture.run();
  assert.deepEqual(Buffer.from(result.records.users, 'base64'), expected.users);
  assert.deepEqual(Buffer.from(result.records.templates, 'base64'), expected.templates);
  assert.equal(result.sourceVerifiedUnchanged, true);
  assert.equal(result.restorationTested, false);
  assert.ok(fixture.users.every(byte => byte === 0));
  assert.ok(fixture.templates.every(byte => byte === 0));
});

test('refuses a different clock or changes during capture; wipes buffers on failure', async () => {
  await assert.rejects(captureFixture({ wrongSerial: true }).run(), /serie/);
  const changed = captureFixture({ changed: true });
  await assert.rejects(changed.run(), /cambio/);
  assert.ok(changed.users.every(byte => byte === 0));
  assert.ok(changed.templates.every(byte => byte === 0));
  const failed = captureFixture({ failDownload: true });
  await assert.rejects(failed.run(), /offline/);
  assert.ok(failed.users.every(byte => byte === 0));
});

test('backup files are exclusive, not overwritten and private on POSIX systems', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-encrypted-backup-'));
  const filename = path.join(directory, 'test.zkbio');
  try {
    writePrivateFile(filename, Buffer.from('encrypted-fixture'));
    assert.throws(() => writePrivateFile(filename, Buffer.from('replacement')), error => error.code === 'EEXIST');
    assert.equal(fs.readFileSync(filename, 'utf8'), 'encrypted-fixture');
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  } finally {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  }
});
