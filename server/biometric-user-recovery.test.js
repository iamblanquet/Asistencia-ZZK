const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { COMMANDS: C } = require('zklib-js/constants');
const { inspectRecords } = require('./services/biometricBackup');
const { recoverDeletedUser } = require('./services/biometricUserRecovery');

function backup() {
  const users = Buffer.alloc(148);
  users.writeUInt32LE(144);
  for (const [offset, uid, id, name] of [[4, 1, '1', 'Other user'], [76, 6, '611', 'MauricioBlanquet']]) {
    users.writeUInt16LE(uid, offset);
    users.write(name, offset + 11, 24);
    users.write(id, offset + 48, 24);
    users[offset + 39] = 1;
  }
  const templates = Buffer.alloc(28);
  templates.writeUInt32LE(24);
  for (const [offset, uid, finger] of [[4, 1, 6], [16, 6, 5]]) {
    templates.writeUInt16LE(12, offset);
    templates.writeUInt16LE(uid, offset + 2);
    templates[offset + 4] = finger;
    templates[offset + 5] = 1;
    templates.write('FAKE!!', offset + 6);
  }
  return { format: 'asisto-biometric-backup', version: 1,
    device: { ip: '192.0.2.1', serial: 'TEST', model: 'F22', firmware: '6.60' },
    records: { users: users.toString('base64'), templates: templates.toString('base64') },
    manifest: inspectRecords(users, templates).manifest };
}

function fixture(settings = {}) {
  const payload = backup();
  const users = Buffer.from(payload.records.users, 'base64');
  const templateRecords = Buffer.from(payload.records.templates, 'base64');
  const full = { users: [{ uid: 1, employeeId: '1' }, { uid: 6, employeeId: '611' }],
    userHashes: new Map([1, 6].map((uid, index) => [uid, crypto.createHash('sha256').update(users.subarray(4 + index * 72, 76 + index * 72)).digest('hex')])),
    templates: inspectRecords(users, templateRecords).templates };
  const missing = { users: full.users.slice(0, 1), userHashes: new Map([[1, full.userHashes.get(1)]]), templates: new Map([['1:6', full.templates.get('1:6')]]) };
  const before = settings.present ? full : { users: [...missing.users], userHashes: new Map(missing.userHashes), templates: new Map(missing.templates) };
  if (settings.uidCollision) { before.users.push({ uid: 6, employeeId: '999' }); before.userHashes.set(6, 'another-user'); }
  if (settings.otherChanged) before.userHashes.set(1, 'changed-user');
  if (settings.otherFingerChanged) before.templates.set('1:6', 'changed-finger');
  if (settings.residualFinger) before.templates.set('6:5', full.templates.get('6:5'));
  if (settings.idCollision) { before.users.push({ uid: 9, employeeId: '611' }); before.userHashes.set(9, 'another-user'); }
  const commands = [];
  let reads = 0, closed = false;
  const device = { connectionType: settings.udp ? 'udp' : 'tcp', zklibTcp: {}, getSerialNumber: async () => settings.wrongSerial ? 'OTHER' : 'TEST',
    getDeviceName: async () => 'F22', getFirmware: async () => settings.wrongFirmware ? 'OTHER' : '6.60' };
  const options = { execute: settings.execute !== false,
    beforeWrite: () => { if (settings.busy) throw new Error('busy'); },
    read: async () => {
      reads++;
      if (reads === 2 && settings.recreated) return full;
      if (reads <= 2) return before;
      if (settings.offlineAfter) throw new Error('offline');
      if (settings.afterMissing || settings.rejectAt) return missing;
      if (settings.afterChanged) return { ...full, templates: new Map([...full.templates, ['6:5', 'wrong-template']]) };
      return full;
    },
    open: () => ({ close() { closed = true; }, async send(command) {
      commands.push(command);
      return { code: settings.rejectAt === command ? C.CMD_ACK_ERROR : C.CMD_ACK_OK };
    } }),
  };
  const selection = { employeeId: '611', expectedName: 'MauricioBlanquet', confirmed: true };
  return { run: override => recoverDeletedUser(device, payload, { ...selection, ...override }, options), commands, state: () => ({ reads, closed }) };
}

test('a present user only produces a waiting plan; recovery never deletes or overwrites it', async () => {
  const probe = fixture({ present: true, execute: false });
  const result = await probe.run();
  assert.equal(result.status, 'waiting_for_deletion');
  assert.equal(result.target.name, 'MauricioBlanquet');
  assert.equal(result.target.fingerIndex, 5);
  assert.equal(probe.commands.length, 0);
  const execute = fixture({ present: true });
  await assert.rejects(execute.run(), /sigue presente/);
  assert.equal(execute.commands.length, 0);
});

test('a missing user has a read-only plan and is restored only with its original user and fingerprint bytes', async () => {
  const plan = fixture({ execute: false });
  assert.equal((await plan.run()).status, 'ready_to_restore');
  assert.equal(plan.commands.length, 0);
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'verified_user_recovery');
  assert.equal(result.deletionRecoveryTested, true);
  assert.equal(result.physicalRecognitionTested, false);
  assert.equal(result.otherUsersAndFingerprintsUnchanged, true);
  assert.equal(result.usersBefore, 1);
  assert.equal(result.usersAfter, 2);
  assert.deepEqual(f.commands, [1502, 1500, 1501, 110, 1013, 1502]);
  assert.deepEqual(f.state(), { reads: 3, closed: true });
});

test('conflicting IDs/UIDs, changed unrelated records and orphan templates prevent all writes', async () => {
  for (const settings of [{ uidCollision: true }, { idCollision: true }, { otherChanged: true }, { otherFingerChanged: true }, { residualFinger: true }]) {
    const f = fixture(settings);
    await assert.rejects(f.run());
    assert.equal(f.commands.length, 0);
  }
});

test('wrong identity/firmware, missing confirmation, busy device or a recreated user prevent all writes', async () => {
  for (const settings of [{ udp: true }, { wrongSerial: true }, { wrongFirmware: true }, { busy: true }, { recreated: true }]) {
    const f = fixture(settings);
    await assert.rejects(f.run());
    assert.equal(f.commands.length, 0);
  }
  for (const selection of [{ employeeId: '0611' }, { employeeId: '999' }, { expectedName: 'Other' }, { confirmed: false }]) {
    const f = fixture();
    await assert.rejects(f.run(selection));
    assert.equal(f.commands.length, 0);
  }
});

test('ACK alone is not recovery; rejection, missing data or altered templates are never success', async () => {
  for (const settings of [{ rejectAt: 110 }, { afterMissing: true }, { afterChanged: true }, { offlineAfter: true }]) {
    const f = fixture(settings);
    const result = await f.run();
    assert.equal(result.verified, false);
    assert.notEqual(result.status, 'verified_user_recovery');
    assert.equal(f.commands.filter(code => code === 110).length, 1);
  }
});
