const { test } = require('node:test');
const assert = require('node:assert/strict');
const { COMMANDS: C } = require('zklib-js/constants');
const { inspectRecords } = require('./services/biometricBackup');
const { prepareIdenticalRestore, testIdenticalRestore } = require('./services/biometricRestoreTest');

function backup() {
  const users = Buffer.alloc(76);
  users.writeUInt32LE(72);
  users.writeUInt16LE(3, 4);
  users.write('private', 7, 8);
  users.write('Test name', 15, 24);
  users.writeUInt32LE(1234, 39);
  users[43] = 1;
  users.write('52', 52, 24);
  const templates = Buffer.alloc(22);
  templates.writeUInt32LE(18);
  templates.writeUInt16LE(18, 4);
  templates.writeUInt16LE(3, 6);
  templates[8] = 4;
  templates[9] = 1;
  templates.write('FAKE-PRINT!!', 10);
  return { format: 'asisto-biometric-backup', version: 1,
    device: { ip: '192.0.2.1', serial: 'TEST', model: 'F22', firmware: '6.60' },
    records: { users: users.toString('base64'), templates: templates.toString('base64') },
    manifest: inspectRecords(users, templates).manifest };
}

function fixture(settings = {}) {
  const payload = backup();
  const templates = inspectRecords(Buffer.from(payload.records.users, 'base64'), Buffer.from(payload.records.templates, 'base64')).templates;
  const initial = { users: [{}], usersHash: payload.manifest.usersSha256, templates };
  const commands = [];
  let reads = 0, checks = 0, closed = false;
  const device = { connectionType: settings.udp ? 'udp' : 'tcp', zklibTcp: {},
    getSerialNumber: async () => settings.wrongSerial ? 'OTHER' : 'TEST',
    getDeviceName: async () => 'F22', getFirmware: async () => '6.60' };
  const options = { execute: settings.execute !== false,
    beforeWrite() { checks++; if (settings.blocked) throw new Error('busy'); },
    read: async () => {
      reads++;
      if (reads === 1 && settings.stale) return { ...initial, usersHash: 'changed' };
      if (reads === 2 && settings.offlineAfter) throw new Error('offline');
      return reads === 2 && settings.changedAfter ? { ...initial, templates: new Map() } : initial;
    },
    open: () => ({ close() { closed = true; }, async send(command, payload = Buffer.alloc(0)) {
      commands.push({ command, payload: Buffer.from(payload) });
      if (command === settings.timeoutAt) throw new Error('timeout');
      return { code: command === settings.rejectAt ? C.CMD_ACK_ERROR : C.CMD_ACK_OK };
    } }),
  };
  return { run: selection => testIdenticalRestore(device, payload, selection === undefined ? { employeeId: '52', fingerIndex: 4 } : selection, options),
    commands, state: () => ({ reads, checks, closed }) };
}

test('high-rate packet retains all original user bytes and exactly one selected template', () => {
  const payload = backup();
  const prepared = prepareIdenticalRestore(payload);
  assert.deepEqual(prepared.target, { uid: 3, employeeId: '52', fingerIndex: 4 });
  assert.equal(prepared.packet.readUInt32LE(0), 73);
  assert.equal(prepared.packet.readUInt32LE(4), 8);
  assert.equal(prepared.packet.readUInt32LE(8), 14);
  assert.equal(prepared.packet[12], 2);
  assert.deepEqual(prepared.packet.subarray(13, 85), Buffer.from(payload.records.users, 'base64').subarray(4));
  assert.equal(prepared.packet[85], 2);
  assert.equal(prepared.packet.readUInt16LE(86), 3);
  assert.equal(prepared.packet[88], 0x14);
  assert.equal(prepared.packet.readUInt32LE(89), 0);
  assert.equal(prepared.packet.readUInt16LE(93), 12);
  assert.deepEqual(prepared.packet.subarray(95), Buffer.from(payload.records.templates, 'base64').subarray(10));
  prepared.packet.fill(0);
});

test('rejects privileged users, missing selections and damaged backup records', () => {
  const payload = backup();
  assert.throws(() => prepareIdenticalRestore(payload, { employeeId: '999' }));
  const users = Buffer.from(payload.records.users, 'base64'); users[6] = 14;
  payload.records.users = users.toString('base64');
  payload.manifest = inspectRecords(users, Buffer.from(payload.records.templates, 'base64')).manifest;
  assert.throws(() => prepareIdenticalRestore(payload));
  payload.manifest.usersCount++;
  assert.throws(() => prepareIdenticalRestore(payload));
});

test('probe compares the entire backup to the clock and never opens a write channel', async () => {
  const f = fixture({ execute: false });
  assert.equal((await f.run({})).status, 'ready');
  assert.deepEqual(f.commands, []);
  assert.equal(f.state().checks, 0);
});

test('write uses only upload/refresh commands and confirms every user and template unchanged', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'verified_identical_write');
  assert.equal(result.allUsersAndFingerprintsUnchanged, true);
  assert.equal(result.deletionRecoveryTested, false);
  assert.equal(result.physicalRecognitionTested, false);
  assert.equal(result.saveAccepted, true);
  assert.deepEqual(f.commands.map(x => x.command), [1502, 1500, 1501, 110, 1013, 1502]);
  const commit = f.commands.find(x => x.command === 110).payload;
  assert.equal(commit.readUInt32LE(0), 12);
  assert.equal(commit.readUInt16LE(4), 0);
  assert.equal(commit.readUInt16LE(6), 8);
  assert.deepEqual(f.state(), { reads: 2, checks: 1, closed: true });
});

test('wrong target, stale state, UDP, missing explicit selection or another writer prevent upload', async () => {
  for (const settings of [{ wrongSerial: true }, { stale: true }, { udp: true }, { blocked: true }]) {
    const f = fixture(settings);
    await assert.rejects(f.run());
    assert.equal(f.commands.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.run({}));
  assert.equal(f.commands.length, 0);
});

test('rejection and timeouts are verified read-only, never retried or represented as success', async () => {
  for (const settings of [{ rejectAt: 110 }, { timeoutAt: 110 }, { rejectAt: 1500 }]) {
    const f = fixture(settings);
    const result = await f.run();
    assert.equal(result.status, 'rejected_unchanged');
    assert.equal(result.verified, false);
    assert.equal(result.allUsersAndFingerprintsUnchanged, true);
    assert.ok(f.commands.filter(x => x.command === 110).length <= 1);
    assert.equal(f.state().closed, true);
  }
});

test('changed data or an unreadable clock after writing require attention', async () => {
  for (const settings of [{ changedAfter: true }, { offlineAfter: true }]) {
    const result = await fixture(settings).run();
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.verified, false);
  }
});
