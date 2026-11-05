const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { COMMANDS: C } = require('zklib-js/constants');
const { validName, validEmployeeId, previewUser, mutateDeviceUser } = require('./services/zkUserManagement');
const { createDeviceUserManager } = require('./services/deviceUsers');

function record(uid, id, name, role = 0) {
  const data = Buffer.alloc(72);
  data.writeUInt16LE(uid); data[2] = role; data.write('secret', 3); data.write(name, 11, 24, 'utf8');
  data.writeUInt32LE(0x1234abcd, 35); data.write(id, 48);
  return data;
}
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function snapshot(records = [record(7, '20', 'Mauricio'), record(8, '1', 'Admin', 14)], templates = new Map([['7:3', 'index'], ['7:4', 'thumb'], ['8:0', 'admin-print']])) {
  return { users: records.map(data => ({ uid: data.readUInt16LE(0), employeeId: data.subarray(48).toString().split('\0')[0], name: data.subarray(11, 35).toString('utf8').split('\0')[0], role: data[2], cardNo: data.readUInt32LE(35) })),
    userHashes: new Map(records.map(data => [data.readUInt16LE(0), hash(data)])), templates };
}
function fixture(action, overrides = {}) {
  const before = overrides.before || snapshot();
  const after = overrides.after || (action === 'rename'
    ? snapshot([record(7, '20', 'José Blanquet'), record(8, '1', 'Admin', 14)])
    : snapshot([record(8, '1', 'Admin', 14)], new Map([['8:0', 'admin-print']])));
  const selected = previewUser(before, '20');
  const commands = [];
  let reads = 0, attempted = false;
  const device = { zklibTcp: { async executeCmd(command, payload) {
    commands.push({ command, payload: Buffer.from(payload) });
    const reply = Buffer.alloc(8); reply.writeUInt16LE(C.CMD_ACK_OK); return reply;
  } } };
  const run = () => mutateDeviceUser(device, action, '20', { name: 'José Blanquet' }, {
    revision: { ...selected, uid: selected.user.uid, ...(overrides.revision || {}) },
    beforeWrite: overrides.beforeWrite || (() => {}), writeAttempted: () => { attempted = true; },
  }, { read: async () => reads++ ? after : before, readRecord: async () => record(7, '20', 'Mauricio') });
  return { run, commands, attempted: () => attempted };
}

test('validates employee IDs and UTF-8 names without allowing control characters', () => {
  assert.equal(validName('  José  '), 'José');
  assert.equal(validEmployeeId('20'), '20');
  for (const value of ['', '\0Admin', 'User\n', 'ñ'.repeat(13)]) assert.throws(() => validName(value));
  for (const value of ['020', '0', '../20', '9999999999']) assert.throws(() => validEmployeeId(value));
});

test('rename changes only the 24-byte name field, retaining password, card, role and ID', async () => {
  const { run, commands } = fixture('rename');
  const result = await run();
  assert.equal(result.employee.name, 'José Blanquet');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, C.CMD_USER_WRQ);
  const original = record(7, '20', 'Mauricio');
  assert.deepEqual(commands[0].payload.subarray(0, 11), original.subarray(0, 11));
  assert.deepEqual(commands[0].payload.subarray(35), original.subarray(35));
});

test('delete sends only the selected UID and verifies its user and fingerprints are gone', async () => {
  const { run, commands } = fixture('delete');
  const result = await run();
  assert.equal(result.removedFingerprints, 2);
  assert.equal(result.users.length, 1);
  assert.equal(commands[0].command, C.CMD_DELETE_USER);
  assert.equal(commands[0].payload.length, 2);
  assert.equal(commands[0].payload.readUInt16LE(0), 7);
  assert.equal(commands[1].command, 1013);
  assert.ok(!commands.some(item => item.command === C.CMD_CLEAR_DATA || item.command === C.CMD_CLEAR_ATTLOG));
});

test('privileged users and stale identity confirmations never send a delete command', async () => {
  const protectedUser = fixture('delete', { before: snapshot([record(7, '20', 'Admin', 14)]) });
  await assert.rejects(protectedUser.run(), error => error.statusCode === 403);
  assert.equal(protectedUser.commands.length, 0);
  const stale = fixture('delete', { revision: { userHash: 'different' } });
  await assert.rejects(stale.run(), /cambiaron/);
  assert.equal(stale.commands.length, 0);
});

test('configuration drift before writing cannot mutate a user', async () => {
  const testCase = fixture('rename', { beforeWrite() { throw new Error('changed device'); } });
  await assert.rejects(testCase.run(), /changed device/);
  assert.equal(testCase.attempted(), false);
  assert.equal(testCase.commands.length, 0);
});

test('unexpected changes to other users, remaining target fingerprints or credentials fail verification', async () => {
  const otherChanged = fixture('delete', { after: snapshot([record(8, '1', 'Changed', 14)], new Map([['8:0', 'admin-print']])) });
  await assert.rejects(otherChanged.run(), /otros usuarios/);
  const remainingPrint = fixture('delete', { after: snapshot([record(8, '1', 'Admin', 14)]) });
  await assert.rejects(remainingPrint.run(), /huellas/);
  const changed = record(7, '20', 'José Blanquet'); changed[3] = 9;
  const credentials = fixture('rename', { after: snapshot([changed, record(8, '1', 'Admin', 14)]) });
  await assert.rejects(credentials.run(), /otros campos/);
});

const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function managerFixture(overrides = {}) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE device_user_actions(id TEXT PRIMARY KEY,device_id TEXT,employee_id TEXT,actor_id TEXT,action TEXT,status TEXT,created_at TEXT,finished_at TEXT,details TEXT);
    CREATE TABLE employees(device_id TEXT,employee_id TEXT,name TEXT,override_name TEXT)`);
  const devices = [{ id: 'a', ip: '127.0.0.1', port: 4370 }, { id: 'b', ip: '127.0.0.2', port: 4370 }];
  let time = 1000;
  const saved = [];
  const deps = { db, withDevice: async (_device, work) => work({}), getDeviceById: id => devices.find(device => device.id === id),
    getRealtimeStatus: () => ({}), isEnrollmentBusy: () => false, read: async () => snapshot(), now: () => time,
    authorizeActor: () => ({ allowPrivilegedUsers: true }),
    saveEmployees: (_id, users) => saved.push(users), mutate: async (_device, _action, _id, _input, control) => {
      control.beforeWrite(); control.writeAttempted(); return { users: [], previousName: 'Old', removedFingerprints: 2 };
    }, ...overrides };
  return { db, deps, devices, saved, setTime: value => { time = value; }, manager: createDeviceUserManager(deps) };
}
const confirmed = token => ({ token, confirmed: true, confirmationId: '20', deleteFingerprints: true });

test('preview sends only safe metadata and a one-use actor/device-scoped confirmation token', async () => {
  const { manager, db, devices } = managerFixture();
  const preview = await manager.preview(devices[0], 'admin', '20');
  assert.equal(preview.fingerprintCount, 2);
  assert.equal(preview.canDelete, true);
  assert.ok(!JSON.stringify(preview).includes('hash'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM device_user_actions').get().n, 0);
  assert.throws(() => manager.execute(devices[1], 'admin', '20', 'delete', confirmed(preview.token)), /confirmacion/);
  assert.throws(() => manager.execute(devices[0], 'other-admin', '20', 'delete', confirmed(preview.token)), /confirmacion/);
  assert.equal((await manager.execute(devices[0], 'admin', '20', 'delete', confirmed(preview.token))).ok, true);
  assert.throws(() => manager.execute(devices[0], 'admin', '20', 'delete', confirmed(preview.token)), /confirmacion/);
  assert.equal(db.prepare('SELECT status FROM device_user_actions').get().status, 'success');
});

test('deletion requires exact typed identity and explicit confirmation and expires after five minutes', async () => {
  const { manager, devices, setTime } = managerFixture();
  const preview = await manager.preview(devices[0], 'admin', '20');
  for (const fields of [{ confirmed: false }, { confirmationId: '2' }, { deleteFingerprints: false }]) {
    assert.throws(() => manager.execute(devices[0], 'admin', '20', 'delete', { ...confirmed(preview.token), ...fields }), error => error.statusCode === 400);
  }
  setTime(301001);
  assert.throws(() => manager.execute(devices[0], 'admin', '20', 'delete', confirmed(preview.token)), /vencio/);
});

test('post-write connection failures are audited as uncertain, never claimed successful', async () => {
  const { db, manager, devices } = managerFixture({ mutate: async (_d, _a, _id, _i, control) => { control.writeAttempted(); throw new Error('offline'); } });
  const preview = await manager.preview(devices[0], 'admin', '20');
  await assert.rejects(manager.execute(devices[0], 'admin', '20', 'delete', confirmed(preview.token)), error => error.needsAttention === true);
  assert.equal(db.prepare('SELECT status FROM device_user_actions').get().status, 'needs_attention');
  assert.equal(manager.isBusy('a'), false);
});

test('active enrollment or realtime collection blocks management', async () => {
  const enrollment = managerFixture({ isEnrollmentBusy: () => true });
  await assert.rejects(enrollment.manager.preview(enrollment.devices[0], 'admin', '20'), /otra operacion/);
  const realtime = managerFixture({ getRealtimeStatus: () => ({ connecting: true }) });
  await assert.rejects(realtime.manager.preview(realtime.devices[0], 'admin', '20'), /tiempo real/);
});

test('management denies access by default and rechecks assignment after a preview read', async () => {
  let connections = 0;
  const denied = managerFixture({ authorizeActor: undefined, withDevice: async () => { connections++; } });
  await assert.rejects(denied.manager.preview(denied.devices[0], 'operator', '20'), error => error.statusCode === 403);
  assert.equal(connections, 0);
  let permitted = true;
  const revoked = managerFixture({ authorizeActor: () => permitted ? { allowPrivilegedUsers: false } : null,
    read: async () => { permitted = false; return snapshot(); } });
  await assert.rejects(revoked.manager.preview(revoked.devices[0], 'operator', '20'), error => error.statusCode === 403);
});

test('operator previews cannot expose privileged or unknown-role device users', async () => {
  const { manager, devices } = managerFixture({ authorizeActor: () => ({ allowPrivilegedUsers: false }) });
  await assert.rejects(manager.preview(devices[0], 'operator', '1'), error => error.statusCode === 403);
  const unknownSnapshot = snapshot([record(7, '20', 'Custom', 1)]);
  const unknown = managerFixture({ read: async () => unknownSnapshot,
    authorizeActor: () => ({ allowPrivilegedUsers: false }) });
  for (const role of [1, null, undefined]) {
    unknownSnapshot.users[0].role = role;
    await assert.rejects(unknown.manager.preview(unknown.devices[0], 'operator', '20'), error => error.statusCode === 403);
  }
});

test('permission revoked while queued prevents mutation and records a failed action', async () => {
  let permitted = true, mutated = false;
  const { manager, db, devices } = managerFixture({ authorizeActor: () => permitted ? { allowPrivilegedUsers: false } : null,
    mutate: async () => { mutated = true; } });
  const preview = await manager.preview(devices[0], 'operator', '20');
  const action = manager.execute(devices[0], 'operator', '20', 'delete', confirmed(preview.token));
  permitted = false;
  await assert.rejects(action, error => error.statusCode === 403);
  assert.equal(mutated, false);
  assert.equal(db.prepare('SELECT status FROM device_user_actions').get().status, 'failed');
  assert.equal(manager.isBusy('a'), false);
});

test('permission revoked immediately before the wire write prevents that write', async () => {
  let permitted = true, attempted = false;
  const { manager, db, devices } = managerFixture({ authorizeActor: () => permitted ? { allowPrivilegedUsers: false } : null,
    mutate: async (_d, _a, _id, _input, control) => {
      permitted = false; control.beforeWrite(); attempted = true; control.writeAttempted();
    } });
  const preview = await manager.preview(devices[0], 'operator', '20');
  await assert.rejects(manager.execute(devices[0], 'operator', '20', 'delete', confirmed(preview.token)), error => error.statusCode === 403);
  assert.equal(attempted, false);
  assert.equal(db.prepare('SELECT status FROM device_user_actions').get().status, 'failed');
});

test('demotion after an administrator preview cannot authorize a privileged rename or any privileged deletion', async () => {
  let admin = true;
  const { manager, db, devices } = managerFixture({ authorizeActor: () => ({ allowPrivilegedUsers: admin }) });
  const preview = await manager.preview(devices[0], 'admin', '1');
  admin = false;
  assert.throws(() => manager.execute(devices[0], 'admin', '1', 'rename', { token: preview.token, confirmed: true, name: 'Changed' }), error => error.statusCode === 403);
  admin = true;
  assert.throws(() => manager.execute(devices[0], 'admin', '1', 'delete', { token: preview.token, confirmed: true, confirmationId: '1', deleteFingerprints: true }), error => error.statusCode === 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM device_user_actions').get().n, 0);
});

test('a target promoted since preview fails the identity revision check before a rename write', async () => {
  const testCase = fixture('rename', { before: snapshot([record(7, '20', 'Mauricio', 14)]),
    revision: { userHash: hash(record(7, '20', 'Mauricio', 0)) } });
  await assert.rejects(testCase.run(), /cambiaron/);
  assert.equal(testCase.attempted(), false);
  assert.equal(testCase.commands.length, 0);
});
