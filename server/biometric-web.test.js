const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { inspectRecords } = require('./services/biometricBackup');
const { encryptArchive, decryptArchive, archiveIndex } = require('./services/biometricArchive');
const { prepareUserRestore } = require('./services/biometricRestoreTest');
const { previewRecovery, restoreArchivedUser, revision } = require('./services/biometricRecovery');
const { createBiometricBackupManager } = require('./services/biometricBackups');
const { createAutomaticArchive } = require('./services/biometricAutomaticArchive');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
const automatic = () => createAutomaticArchive({ privateKey: testKey });

const password = 'Test-only-local-backup-2026';
function payload() {
  const users = Buffer.alloc(148);
  users.writeUInt32LE(144);
  for (const [offset, uid, id, name] of [[4, 1, '1', 'Existing'], [76, 6, '611', 'Recovery user']]) {
    users.writeUInt16LE(uid, offset); users.write(name, offset + 11, 24); users.write(id, offset + 48, 24); users[offset + 39] = 1;
  }
  const templates = Buffer.alloc(40);
  templates.writeUInt32LE(36);
  for (const [offset, uid, finger] of [[4, 1, 6], [16, 6, 4], [28, 6, 5]]) {
    templates.writeUInt16LE(12, offset); templates.writeUInt16LE(uid, offset + 2); templates[offset + 4] = finger; templates[offset + 5] = 1; templates.write('FAKE!!', offset + 6);
  }
  return { format: 'asisto-biometric-backup', version: 1, createdAt: '2026-11-04T15:00:00.000Z',
    device: { id: 'a', ip: '192.0.2.1', name: 'Device A', serial: 'TEST', model: 'F22', firmware: '6.60' },
    records: { users: users.toString('base64'), templates: templates.toString('base64') }, manifest: inspectRecords(users, templates).manifest };
}
function device() {
  return { connectionType: 'tcp', zklibTcp: {}, getSerialNumber: async () => 'TEST', getDeviceName: async () => 'F22', getFirmware: async () => '6.60' };
}
function snapshots() {
  const index = archiveIndex(payload());
  const full = { users: index.employees, userHashes: index.userHashes, templates: index.templates };
  const missing = { users: full.users.filter(user => user.uid !== 6), userHashes: new Map([[1, full.userHashes.get(1)]]), templates: new Map([['1:6', full.templates.get('1:6')]]) };
  return { full, missing };
}

test('portable password archive preserves all raw bytes and does not expose names or fingerprint data', async () => {
  const original = payload(), archive = await encryptArchive(original, password);
  assert.deepEqual(await decryptArchive(archive.toString('base64'), password), original);
  assert.ok(!archive.toString().includes('Recovery user'));
  assert.ok(!archive.toString().includes(original.records.templates));
  const another = await encryptArchive(original, password);
  assert.notDeepEqual(archive, another);
});
test('rejects weak passwords, corrupted archives, wrong passwords and unsupported KDF settings', async () => {
  await assert.rejects(encryptArchive(payload(), 'short'));
  const archive = await encryptArchive(payload(), password), envelope = JSON.parse(archive);
  await assert.rejects(decryptArchive(archive.toString('base64'), password + '!'), error => error.code === 'BACKUP_AUTH_FAILED');
  for (const field of ['tag', 'nonce', 'ciphertext']) {
    const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1;
    await assert.rejects(decryptArchive(Buffer.from(JSON.stringify({ ...envelope, [field]: bytes.toString('base64') })).toString('base64'), password));
  }
  await assert.rejects(decryptArchive(Buffer.from(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 2147483648 } })).toString('base64'), password), /no compatible/);
  await assert.rejects(decryptArchive('@@@', password));
  await assert.rejects(decryptArchive(Buffer.from(JSON.stringify({ version: 1 })).toString('base64'), password), /RSA/);
});
test('multi-finger packet preserves the complete user record and every template with distinct offsets', () => {
  const original = payload(), prepared = prepareUserRestore(original, { employeeId: '611' });
  assert.deepEqual(prepared.target.fingerIndices, [4, 5]);
  assert.equal(prepared.packet.readUInt32LE(4), 16);
  assert.equal(prepared.packet.readUInt32LE(8), 16);
  assert.deepEqual(prepared.packet.subarray(13, 85), Buffer.from(original.records.users, 'base64').subarray(76));
  assert.equal(prepared.packet[88], 0x14);
  assert.equal(prepared.packet[96], 0x15);
  assert.equal(prepared.packet.readUInt32LE(97), 8);
  prepared.packet.fill(0);
});
test('preview blocks existing/protected users, UID collisions and residual templates without exposing bytes', async () => {
  const { missing } = snapshots();
  const p = payload();
  const preview = await previewRecovery(device(), p.device, p, { read: async () => missing });
  assert.equal(preview.employees.find(user => user.employeeId === '1').eligible, false);
  assert.equal(preview.employees.find(user => user.employeeId === '611').eligible, true);
  assert.ok(!JSON.stringify(preview.employees).includes(p.records.templates));
  const collision = { ...missing, users: [...missing.users, { uid: 6, employeeId: '999' }], userHashes: new Map([...missing.userHashes, [6, 'other-user']]) };
  assert.equal((await previewRecovery(device(), p.device, p, { read: async () => collision })).employees.find(user => user.employeeId === '611').eligible, false);
  await assert.rejects(previewRecovery(device(), { ...p.device, id: 'other' }, p, { read: async () => missing }), /no corresponde/);
});
test('recovery adds the selected user and all fingers, preserving unrelated live data and requiring a fresh revision', async () => {
  const p = payload(), { full, missing } = snapshots();
  const extraUser = { uid: 9, employeeId: '900' };
  missing.users.push(extraUser); missing.userHashes.set(9, 'newer-live-user');
  full.users.push(extraUser); full.userHashes.set(9, 'newer-live-user');
  let reads = 0, writes = 0;
  const commands = [];
  const result = await restoreArchivedUser(device(), p.device, p, '611', { revision: revision(missing), beforeWrite() {}, writeAttempted() { writes++; } }, {
    read: async () => reads++ ? full : missing,
    open: () => ({ close() {}, async send(command) { commands.push(command); return { code: 2000 }; } }),
  });
  assert.equal(writes, 1); assert.equal(result.fingerprintCount, 2); assert.equal(result.users.length, 3);
  assert.deepEqual(commands, [1502, 1500, 1501, 110, 1013, 1502]);
  await assert.rejects(restoreArchivedUser(device(), p.device, p, '611', { revision: 'stale' }, { read: async () => missing }), /cambio/);
});
test('an ACK or a partial restoration is not sufficient to claim success', async () => {
  const p = payload(), { full, missing } = snapshots();
  const partial = { ...full, templates: new Map(full.templates) }; partial.templates.delete('6:5');
  let reads = 0;
  await assert.rejects(restoreArchivedUser(device(), p.device, p, '611', { revision: revision(missing), beforeWrite() {}, writeAttempted() {} }, {
    read: async () => reads++ ? partial : missing, open: () => ({ close() {}, send: async () => ({ code: 2000 }) }),
  }), /verificar/);
});

const databases = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function managerFixture(settings = {}) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE biometric_backup_actions(id TEXT PRIMARY KEY,device_id TEXT,actor_id TEXT,action TEXT,employee_id TEXT,status TEXT,created_at TEXT,finished_at TEXT,details TEXT)`);
  let clock = 1000000, saved = 0, writeCalls = 0;
  const p = payload();
  const config = { ...p.device, port: 4370 };
  const manager = createBiometricBackupManager({ db, now: () => clock, withDevice: async (config, work) => work(device()),
    archiveService: automatic(),
    getDeviceById: () => settings.drift ? { ...config, ip: '192.0.2.99' } : config,
    getRealtimeStatus: () => ({ active: Boolean(settings.realtime) }), isDeviceBusy: () => settings.busy,
    saveEmployees: () => saved++, capture: async () => p,
    preview: async () => ({ device: config, revision: 'rev', employees: [{ employeeId: '611', name: 'Recovery user', eligible: true, fingers: [4, 5], fingerprintCount: 2 }] }),
    restore: async (connected, config, payload, id, control) => {
      writeCalls++; control.beforeWrite(); control.writeAttempted();
      if (settings.writeFails) throw new Error('secret-packet-or-password-do-not-return');
      return { users: [], employee: { employeeId: id, name: 'Recovery user' }, fingerprintCount: 2 };
    },
  });
  return { manager, db, config, advance: () => { clock += 300001; }, state: () => ({ saved, writeCalls }) };
}
async function encodedBody() { return { archive: (await automatic().encrypt(payload())).toString('base64') }; }
test('download returns only encrypted data and audits safe metadata, never secrets or template bytes', async () => {
  const f = managerFixture();
  const download = await f.manager.download(f.config, 'actor', { confirmed: true });
  assert.ok(download.filename.endsWith('.zkbio'));
  assert.deepEqual(await automatic().decrypt(download.buffer.toString('base64')), payload());
  assert.equal(download.verified, true);
  const audit = JSON.stringify(f.manager.history('a'));
  assert.ok(!audit.includes(password)); assert.ok(!audit.includes(payload().records.templates));
  assert.equal(f.state().writeCalls, 0);
});
test('restore tokens are actor/device/archive scoped, expire, require typed ID and are single-use', async () => {
  const f = managerFixture(), body = await encodedBody();
  const preview = await f.manager.preview(f.config, 'actor', body);
  const confirmed = { ...body, token: preview.token, employeeId: '611', confirmationId: '611', confirmed: true };
  for (const invalid of [{ confirmed: false }, { confirmationId: '1' }, { archive: body.archive + 'A' }, { employeeId: '999', confirmationId: '999' }]) {
    assert.throws(() => f.manager.restore(f.config, 'actor', { ...confirmed, ...invalid }));
  }
  assert.throws(() => f.manager.restore(f.config, 'other-actor', confirmed));
  assert.throws(() => f.manager.restore({ ...f.config, id: 'b' }, 'actor', confirmed));
  const result = await f.manager.restore(f.config, 'actor', confirmed);
  assert.equal(result.ok, true); assert.equal(f.state().saved, 1);
  assert.throws(() => f.manager.restore(f.config, 'actor', confirmed));
  const second = await f.manager.preview(f.config, 'actor', body); f.advance();
  assert.throws(() => f.manager.restore(f.config, 'actor', { ...confirmed, token: second.token }));
});
test('write uncertainty is audited without leaking exceptions or inventing success', async () => {
  const f = managerFixture({ writeFails: true }), body = await encodedBody();
  const preview = await f.manager.preview(f.config, 'actor', body);
  await assert.rejects(f.manager.restore(f.config, 'actor', { ...body, token: preview.token, employeeId: '611', confirmationId: '611', confirmed: true }), error => error.needsAttention && !error.message.includes('secret-packet'));
  assert.equal(f.manager.history('a')[0].status, 'needs_attention');
  assert.equal(f.state().saved, 0);
});
test('realtime/enrollment/user writes block backup operations and configuration drift prevents hardware access', async () => {
  for (const settings of [{ realtime: true }, { busy: true }]) {
    const f = managerFixture(settings);
    assert.throws(() => f.manager.download(f.config, 'actor', { confirmed: true }));
  }
  const f = managerFixture({ drift: true });
  await assert.rejects(f.manager.download(f.config, 'actor', { confirmed: true }), /cambio/);
});
test('failed decryptions are rate limited and never reach the clock', async () => {
  const f = managerFixture(), body = await encodedBody();
  const changed = JSON.parse(Buffer.from(body.archive, 'base64')); const tag = Buffer.from(changed.tag, 'base64'); tag[0] ^= 1; changed.tag = tag.toString('base64');
  for (let i = 0; i < 5; i++) await assert.rejects(f.manager.preview(f.config, 'actor', { archive: Buffer.from(JSON.stringify(changed)).toString('base64') }));
  await assert.rejects(f.manager.preview(f.config, 'actor', body), error => error.statusCode === 429);
  assert.equal(f.state().writeCalls, 0);
});

test('automatic archives need no password and are authenticated to their recovery key', async () => {
  const service = automatic();
  const encrypted = await service.encrypt(payload());
  assert.equal(JSON.parse(encrypted).version, 3);
  assert.deepEqual(await service.decrypt(encrypted.toString('base64')), payload());
  const exported = await service.exportKey();
  assert.ok(exported.filename.endsWith('.zkkey'));
  const anotherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
  const other = createAutomaticArchive({ privateKey: anotherKey });
  await assert.rejects(other.decrypt(encrypted.toString('base64')), /clave no corresponde/);
  assert.deepEqual(await other.decrypt(encrypted.toString('base64'), { recoveryKey: exported.buffer.toString() }), payload());
  const envelope = JSON.parse(encrypted); envelope.keyId = 'f'.repeat(64);
  await assert.rejects(service.decrypt(Buffer.from(JSON.stringify(envelope)).toString('base64')));
});
test('the automatic recovery key survives restart and is never silently overwritten', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-recovery-key-'));
  const filename = path.join(directory, 'recovery-key.pem');
  try {
    const first = createAutomaticArchive({ directory });
    const encrypted = await first.encrypt(payload());
    const original = fs.readFileSync(filename);
    assert.deepEqual(await createAutomaticArchive({ directory }).decrypt(encrypted.toString('base64')), payload());
    assert.deepEqual(fs.readFileSync(filename), original);
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    fs.writeFileSync(filename, 'damaged-key');
    await assert.rejects(createAutomaticArchive({ directory }).encrypt(payload()), /No se pudo abrir la clave/);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'damaged-key');
  } finally { if (fs.existsSync(filename)) fs.unlinkSync(filename); fs.rmdirSync(directory); }
});
test('recovery key download is audited without storing private material; old password files remain explicit legacy files', async () => {
  const f = managerFixture();
  const exported = await f.manager.recoveryKey(f.config, 'actor');
  assert.ok(exported.buffer.toString().includes('PRIVATE KEY'));
  assert.equal(f.manager.history('a')[0].details.type, 'recovery-key');
  assert.ok(!JSON.stringify(f.manager.history('a')).includes('PRIVATE KEY'));
  assert.throws(() => f.manager.download(f.config, 'actor', { password, confirmed: true }), /Recargue/);
  const legacy = (await encryptArchive(payload(), password)).toString('base64');
  await assert.rejects(automatic().decrypt(legacy), /archivo anterior/);
  assert.deepEqual(await automatic().decrypt(legacy, { password }), payload());
});
