const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { COMMANDS: C } = require('zklib-js/constants');
const { createTCPHeader } = require('zklib-js/utils');
const { indexFingerprintRecords } = require('./services/zkFingerprintRecords');
const { readEnrollmentSnapshot, captureFingerprint } = require('./services/zkEnrollment');
const { inspectRecords, captureBackup, validateBackup } = require('./services/biometricBackup');
const { prepareUserRestore } = require('./services/biometricRestoreTest');
const { previewRecovery, restoreArchivedUser, revision } = require('./services/biometricRecovery');

const oldUser = { uid: 11, employeeId: '616', name: 'Existing test user', role: 0 };
const newUser = { uid: 12, employeeId: '617', name: 'New test user', role: 0 };
function record(body, uid = 11, finger = 6) {
  const bytes = Buffer.from(body);
  const result = Buffer.alloc(bytes.length + 6);
  result.writeUInt16LE(result.length); result.writeUInt16LE(uid, 2); result[4] = finger; result[5] = 1;
  bytes.copy(result, 6);
  return result;
}
function download(records) {
  const result = Buffer.concat([Buffer.alloc(4), ...records]);
  result.writeUInt32LE(result.length - 4);
  return result;
}
function usersData(users = [oldUser]) {
  const result = Buffer.alloc(4 + users.length * 72); result.writeUInt32LE(result.length - 4);
  users.forEach((user, index) => {
    const offset = 4 + index * 72;
    result.writeUInt16LE(user.uid, offset); result[offset + 2] = user.role;
    result.write(user.name, offset + 11, 24); result.write(user.employeeId, offset + 48, 24);
  });
  return result;
}
const prints = [record(Buffer.alloc(814, 0x41)), record(Buffer.alloc(718, 0x42))];
const index = records => indexFingerprintRecords(download(records), new Set([11, 12]));
function snapshot(users, records, usersHash = 'same-users') {
  const parsed = index(records);
  return { users, usersHash, userHashes: new Map(users.map(user => [user.uid, `user-${user.uid}`])),
    fingerCount: parsed.recordCount, templates: parsed.templates };
}

test('single-record slots retain their legacy hash and multiple records occupy only one finger', () => {
  const single = index([prints[0]]);
  assert.equal(single.templates.get('11:6'), crypto.createHash('sha256').update(prints[0]).digest('hex'));
  const multiple = index(prints);
  assert.equal(multiple.templates.size, 1);
  assert.equal(multiple.recordCount, 2);
  assert.equal(multiple.owners.size, 1);
  assert.notEqual(multiple.templates.get('11:6'), single.templates.get('11:6'));
});

test('grouped integrity is order-independent but preserves every record and its multiplicity', () => {
  const signature = index(prints).templates.get('11:6');
  assert.equal(index([...prints].reverse()).templates.get('11:6'), signature);
  const changed = Buffer.from(prints[1]); changed[changed.length - 1] ^= 1;
  for (const records of [[prints[0]], [prints[1]], [prints[0], changed], [...prints, prints[0]]]) {
    assert.notEqual(index(records).templates.get('11:6'), signature);
  }
  assert.notEqual(index([prints[0], prints[0]]).templates.get('11:6'), index([prints[0]]).templates.get('11:6'));
});

test('invalid owners, fingers, headers, lengths and empty templates are still rejected', () => {
  for (const invalid of [record('fake', 0), record('fake', 99), record('fake', 11, 10), record('', 11)]) {
    assert.throws(() => index([invalid]));
  }
  const truncated = download(prints).subarray(0, -1);
  assert.throws(() => indexFingerprintRecords(truncated, new Set([11])));
  const incompleteHeader = Buffer.from([1, 0, 0, 0, 1]);
  assert.throws(() => indexFingerprintRecords(incompleteHeader, new Set([11])));
  assert.equal(indexFingerprintRecords(Buffer.alloc(0), new Set()).recordCount, 0);
});

test('real snapshot decoding validates the record counter rather than unique finger count', async () => {
  const users = usersData();
  const templates = download(prints);
  const socket = new EventEmitter();
  socket.write = (packet, callback) => {
    callback();
    const payload = packet.readUInt16LE(17) === 9 ? users : templates;
    queueMicrotask(() => socket.emit('data', createTCPHeader(C.CMD_DATA, 1, 1, payload)));
  };
  let counter = 2;
  const device = { connectionType: 'tcp', getDeviceName: async () => 'F22ID', zklibTcp: {
    socket, sessionId: 1, replyId: 0, timeout: 100, freeData: async () => {}, executeCmd: async () => {
      const response = Buffer.alloc(40); response.writeUInt16LE(C.CMD_ACK_OK);
      response.writeUInt32LE(1, 24); response.writeUInt32LE(counter, 32); return response;
    },
  } };
  const result = await readEnrollmentSnapshot(device);
  assert.equal(result.fingerCount, 2);
  assert.equal(result.templates.size, 1);
  assert.equal(result.templates.get('11:6'), index(prints).templates.get('11:6'));
  assert.equal(result.users[0].employeeId, '616');
  assert.ok(!JSON.stringify(result.users).includes(prints[0].toString('base64')));
  counter = 1;
  await assert.rejects(readEnrollmentSnapshot(device), /Listado de huellas incompleto/);
});

async function capture({ afterPrints = [...prints, record('new-fake-template', 12)], unchangedPoll = false, create = false } = {}) {
  const before = snapshot(create ? [oldUser] : [oldUser, newUser], prints, create ? 'old-users' : 'same-users');
  const added = snapshot([oldUser, newUser], prints);
  const after = snapshot([oldUser, newUser], afterPrints);
  const states = create ? [before, added, after] : [before, after];
  let reads = 0, polls = 0, time = 0, userWrites = 0;
  const commands = [];
  const result = await captureFingerprint({ zklibTcp: { async executeCmd(command, payload) {
    userWrites++; assert.equal(command, C.CMD_USER_WRQ); assert.equal(payload[2], 0);
    assert.equal(payload.readUInt16LE(0), 12); assert.equal(payload.subarray(48).toString().split('\0')[0], '617');
    const response = Buffer.alloc(8); response.writeUInt16LE(C.CMD_ACK_OK); return response;
  } } }, { employeeId: create ? '' : '617', fingerIndex: 6, createEmployee: create, name: newUser.name }, {
    signal: new AbortController().signal, report() {},
  }, { read: async () => states[reads++], now: () => time, sleep: async () => { time += 2000; }, duration: 6000,
    open: () => ({ close() {}, async send(command) {
      commands.push(command);
      const payload = Buffer.alloc(28);
      if (command === C.CMD_GET_FREE_SIZES) {
        polls++; payload.writeUInt32LE(unchangedPoll && polls === 1 ? 2 : after.fingerCount, 24);
      }
      return { code: C.CMD_ACK_OK, payload };
    } }),
  });
  return { result, polls, commands, userWrites };
}

test('enrollment waits for a new physical record, not the already larger duplicate-record counter', async () => {
  const result = await capture({ unchangedPoll: true });
  assert.equal(result.polls, 2);
  assert.equal(result.result.status, 'completed');
  assert.equal(result.userWrites, 0);
});

test('new collaborator enrollment preserves both old records and verifies multiple new records in one free slot', async () => {
  const result = await capture({ create: true, afterPrints: [...prints, record('new-one', 12), record('new-two', 12)] });
  assert.equal(result.userWrites, 1);
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.employeeCreated, true);
});

test('any loss, change or added repetition in pre-existing records prevents a successful enrollment result', async () => {
  const changed = Buffer.from(prints[1]); changed[changed.length - 1] ^= 1;
  for (const existing of [[prints[0]], [prints[0], changed], [...prints, prints[0]]]) {
    const { result } = await capture({ afterPrints: [...existing, record('new-fake-template', 12)] });
    assert.equal(result.status, 'needs_attention');
  }
});

test('a repeated occupied slot is still protected before opening any capture channel', async () => {
  let opened = false;
  await assert.rejects(captureFingerprint({}, { employeeId: '616', fingerIndex: 6 }, {
    signal: new AbortController().signal, report() {},
  }, { read: async () => snapshot([oldUser], prints), open() { opened = true; } }), /No se reemplazara/);
  assert.equal(opened, false);
});

function backupPayload() {
  const users = usersData(), templates = download(prints);
  return { format: 'asisto-biometric-backup', version: 1, device: { id: 'test', serial: 'TEST', model: 'F22', firmware: 'TEST' },
    records: { users: users.toString('base64'), templates: templates.toString('base64') }, manifest: inspectRecords(users, templates).manifest };
}

test('backup preserves both raw records, counts both and verifies the same grouped signature as enrollment', async () => {
  const payload = backupPayload();
  assert.equal(payload.manifest.templatesCount, 2);
  assert.equal(payload.manifest.usersWithTemplates, 1);
  assert.equal(inspectRecords(Buffer.from(payload.records.users, 'base64'), Buffer.from(payload.records.templates, 'base64')).templates.get('11:6'), index(prints).templates.get('11:6'));
  const before = { ...snapshot([oldUser], prints), usersHash: payload.manifest.usersSha256 };
  let reads = 0;
  const buffers = [Buffer.from(payload.records.users, 'base64'), Buffer.from(payload.records.templates, 'base64')];
  const result = await captureBackup({ getSerialNumber: async () => 'TEST', getFirmware: async () => 'TEST', getDeviceName: async () => 'F22',
    zklibTcp: { freeData: async () => {} } }, payload.device, {
    snapshot: async () => before, download: async () => buffers[reads++],
  });
  assert.deepEqual(result.records, payload.records);
  assert.doesNotThrow(() => validateBackup(result));
  assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('duplicate-slot backup remains downloadable but restoration is blocked before any device writes', async () => {
  const payload = backupPayload();
  assert.throws(() => prepareUserRestore(payload, { employeeId: '616' }), /varias plantillas/);
  const empty = snapshot([], []);
  const device = { connectionType: 'tcp', getSerialNumber: async () => 'TEST', getFirmware: async () => 'TEST', getDeviceName: async () => 'F22' };
  const preview = await previewRecovery(device, payload.device, payload, { read: async () => empty });
  assert.equal(preview.employees[0].eligible, false);
  assert.match(preview.employees[0].reason, /mismo dedo/);
  let writes = 0;
  await assert.rejects(restoreArchivedUser(device, payload.device, payload, '616', {
    revision: revision(empty), beforeWrite() { writes++; }, writeAttempted() { writes++; },
  }, { read: async () => empty, open() { writes++; } }), /mismo dedo/);
  assert.equal(writes, 0);
});
