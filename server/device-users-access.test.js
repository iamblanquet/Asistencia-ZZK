const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMANDS: C } = require('zklib-js/constants');
const { mutateDeviceUser } = require('./services/zkUserManagement');

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'asisto-device-user-access-'));
process.env.ASISTENCIA_DATA_DIR = directory;
process.env.INITIAL_ADMIN_PASSWORD = 'Device-Users-Test-Only-42';
const { db } = require('./services/sqlite');
const { addDevice, saveEmployees, getEmployees } = require('./services/db');
const { addStoredEvents } = require('./services/eventStore');
const { authenticate, createUser, updateUser, deleteUser } = require('./services/auth');
const management = require('./services/deviceUsers');
const a = addDevice({ name: 'Assigned test clock', ip: '192.0.2.10' }).id;
const b = addDevice({ name: 'Other test clock', ip: '192.0.2.11' }).id;
const hardware = new Map();
const fingerprints = new Map();
const connections = [], writes = [];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function record(uid, id, name, role = 0) {
  const bytes = Buffer.alloc(72);
  bytes.writeUInt16LE(uid); bytes[2] = role; bytes.write('test-secret', 3, 8);
  bytes.write(name, 11, 24); bytes.write(id, 48, 24);
  return bytes;
}
function snapshot(device) {
  const records = [...hardware.get(device.id).values()];
  return { users: records.map(bytes => ({ uid: bytes.readUInt16LE(0), employeeId: bytes.subarray(48).toString().split('\0')[0],
    name: bytes.subarray(11, 35).toString().split('\0')[0], role: bytes[2], cardNo: 0 })),
    userHashes: new Map(records.map(bytes => [bytes.readUInt16LE(0), hash(bytes)])), templates: new Map(fingerprints.get(device.id)) };
}
for (const id of [a, b]) {
  hardware.set(id, new Map([record(1, '1', 'Protected test admin', 14), record(20, '20', 'Normal test user'),
    record(21, '21', 'Delete test user'), record(22, '22', 'Custom role', 1)].map(bytes => [bytes.readUInt16LE(0), bytes])));
  fingerprints.set(id, new Map([['1:0', 'admin-template'], ['20:3', 'user-template'], ['21:4', 'delete-template']]));
  saveEmployees(id, snapshot({ id }).users);
  addStoredEvents(id, [{ employeeId: '21', employeeName: 'Delete test user', timestamp: '2026-11-05T08:00:00-06:00' }]);
}
const accounts = {};
for (const [username, assignedDevices] of [['operator', [a]], ['other-operator', [a]], ['unassigned', []], ['removed-operator', [a]]]) {
  accounts[username] = createUser({ username, password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices });
}
const tokens = Object.fromEntries(['admin', ...Object.keys(accounts)].map(username =>
  [username, authenticate(username, process.env.INITIAL_ADMIN_PASSWORD).token]));
const originalFactory = management.createDeviceUserManager;
mock.method(management, 'createDeviceUserManager', dependencies => originalFactory({ ...dependencies,
  withDevice: async (device, work) => {
    connections.push(device.id);
    return work({ id: device.id, zklibTcp: { async executeCmd(command, payload) {
      writes.push({ deviceId: device.id, command, payload: Buffer.from(payload) });
      if (command === C.CMD_USER_WRQ) hardware.get(device.id).set(payload.readUInt16LE(0), Buffer.from(payload));
      else if (command === C.CMD_DELETE_USER) {
        const uid = payload.readUInt16LE(0); hardware.get(device.id).delete(uid);
        for (const key of fingerprints.get(device.id).keys()) if (key.startsWith(`${uid}:`)) fingerprints.get(device.id).delete(key);
      } else assert.equal(command, C.CMD_REFRESHDATA);
      const response = Buffer.alloc(8); response.writeUInt16LE(C.CMD_ACK_OK); return response;
    } } });
  },
  read: async device => snapshot(device),
  mutate: (device, action, id, input, control) => mutateDeviceUser(device, action, id, input, control, {
    read: async connected => snapshot(connected),
    readRecord: async (connected, user) => Buffer.from(hardware.get(connected.id).get(user.uid)),
  }),
}));
const app = require('./index');
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve)); mock.restoreAll(); db.close();
  assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot);
  assert.ok(path.basename(directory).startsWith('asisto-device-user-access-'));
  fs.rmSync(directory, { recursive: true, force: true });
});
async function request(id = '20', { actor = 'operator', deviceId = a, method = 'GET', body = {}, route } = {}) {
  const params = new URLSearchParams(); if (deviceId !== null) params.set('deviceId', deviceId);
  const response = await fetch(`${base}${route || `/api/device/users/${id}`}?${params}`, { method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

test('operator preview on an assigned clock exposes only confirmation metadata', async () => {
  const result = await request();
  assert.equal(result.status, 200); assert.equal(result.data.employee.role, 0); assert.equal(result.data.canDelete, true);
  assert.equal(result.data.fingerprintCount, 1);
  for (const secret of ['test-secret', 'user-template', 'userHash', 'fingerprintRevision']) assert.ok(!JSON.stringify(result.data).includes(secret));
});

test('GET, PUT and DELETE require login, explicit device and current assignment before hardware access', async () => {
  const previous = connections.length;
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await request('20', { actor: null, method })).status, 401);
    assert.equal((await request('20', { deviceId: null, method })).status, 400);
    assert.equal((await request('20', { deviceId: b, method })).status, 404);
    assert.equal((await request('20', { actor: 'unassigned', method })).status, 404);
  }
  assert.equal(connections.length, previous);
});

test('operator rename reaches the simulated clock and SQL, preserves role and credentials and audits the real actor', async () => {
  const preview = (await request()).data;
  const oldRecord = Buffer.from(hardware.get(a).get(20));
  const result = await request('20', { method: 'PUT', body: { token: preview.token, confirmed: true, name: 'Updated normal user',
    actorId: 'usr-admin', role: 14, action: 'role', allowPrivilegedUsers: true } });
  assert.equal(result.status, 200); assert.equal(result.data.status, 'success');
  const changed = hardware.get(a).get(20);
  assert.deepEqual(changed.subarray(0, 11), oldRecord.subarray(0, 11));
  assert.deepEqual(changed.subarray(35), oldRecord.subarray(35));
  assert.equal(snapshot({ id: a }).users.find(user => user.employeeId === '20').name, 'Updated normal user');
  assert.equal(getEmployees(a).find(user => user.employeeId === '20').name, 'Updated normal user');
  assert.equal(snapshot({ id: b }).users.find(user => user.employeeId === '20').name, 'Normal test user');
  assert.equal(db.prepare('SELECT actor_id FROM device_user_actions WHERE id=?').get(result.data.auditId).actor_id, accounts.operator.id);
  assert.equal((await request('20', { method: 'PUT', body: { token: preview.token, confirmed: true, name: 'Replay' } })).status, 409);
});

test('operators cannot inspect or forge writes to privileged and unknown-role users', async () => {
  const count = writes.length;
  for (const id of ['1', '22']) {
    assert.equal((await request(id)).status, 403);
    assert.equal((await request(id, { method: 'PUT', body: { token: 'forged', confirmed: true, name: 'Bad', role: 0 } })).status, 409);
  }
  const adminPreview = (await request('1', { actor: 'admin' })).data;
  assert.equal((await request('1', { method: 'PUT', body: { token: adminPreview.token, confirmed: true, name: 'Bad' } })).status, 409);
  assert.equal((await request('1', { actor: 'admin', method: 'DELETE', body: { token: adminPreview.token, confirmed: true, confirmationId: '1', deleteFingerprints: true } })).status, 403);
  assert.equal(writes.length, count);
});

test('confirmation tokens cannot be transferred across actors, collaborators or devices', async () => {
  const preview = (await request()).data;
  const body = { token: preview.token, confirmed: true, name: 'Bad' };
  const count = writes.length;
  assert.equal((await request('20', { actor: 'other-operator', method: 'PUT', body })).status, 409);
  assert.equal((await request('21', { method: 'PUT', body })).status, 409);
  assert.equal((await request('20', { actor: 'admin', deviceId: b, method: 'PUT', body })).status, 409);
  assert.equal(writes.length, count);
});

test('operator deletion requires typed ID and explicit confirmation, removes only its clock user and retains history', async () => {
  const preview = (await request('21')).data;
  const body = { token: preview.token, confirmed: true, confirmationId: '21', deleteFingerprints: true };
  const events = db.prepare('SELECT count(*) AS n FROM events').get().n;
  const count = writes.length;
  for (const invalid of [{ confirmed: false }, { confirmationId: '20' }, { deleteFingerprints: false }]) {
    assert.equal((await request('21', { method: 'DELETE', body: { ...body, ...invalid } })).status, 400);
  }
  assert.equal(writes.length, count);
  const result = await request('21', { method: 'DELETE', body });
  assert.equal(result.status, 200);
  assert.equal(hardware.get(a).has(21), false); assert.equal(fingerprints.get(a).has('21:4'), false);
  assert.equal(hardware.get(b).has(21), true); assert.equal(fingerprints.get(b).has('21:4'), true);
  assert.equal(getEmployees(a).find(user => user.employeeId === '21').devicePresent, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, events);
  assert.equal(db.prepare('SELECT actor_id,action FROM device_user_actions WHERE id=?').get(result.data.auditId).actor_id, accounts.operator.id);
});

test('revocation or account deletion invalidates a preview without changing the simulated clock', async () => {
  const count = writes.length;
  const preview = (await request()).data;
  updateUser(accounts.operator.id, { assignedDevices: [] });
  try {
    assert.equal((await request('20', { method: 'PUT', body: { token: preview.token, confirmed: true, name: 'Bad' } })).status, 404);
  } finally { updateUser(accounts.operator.id, { assignedDevices: [a] }); }
  const removed = (await request('20', { actor: 'removed-operator' })).data;
  deleteUser(accounts['removed-operator'].id);
  assert.equal((await request('20', { actor: 'removed-operator', method: 'DELETE', body: {
    token: removed.token, confirmed: true, confirmationId: '20', deleteFingerprints: true,
  } })).status, 401);
  assert.equal(writes.length, count);
});

test('backup, restore, recovery-key and portal privileges are not granted by device-user management', async () => {
  const count = connections.length;
  for (const [route, method] of [['/api/device/biometric-backups/download', 'POST'], ['/api/device/biometric-backups/restore', 'POST'],
    ['/api/device/biometric-backups/recovery-key', 'GET'], ['/api/admin/users', 'GET']]) {
    assert.equal((await request('20', { route, method })).status, 403);
  }
  assert.equal(connections.length, count);
});
