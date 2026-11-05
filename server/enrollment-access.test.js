const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-enrollment-access-'));
process.env.ASISTENCIA_DATA_DIR = directory;
process.env.INITIAL_ADMIN_PASSWORD = 'Enrollment-Access-Test-42';
const { db } = require('./services/sqlite');
const { addDevice, saveEmployees } = require('./services/db');
const { authenticate, createUser, updateUser } = require('./services/auth');
const enrollment = require('./services/enrollment');
const { assertEnrollmentTarget } = require('./services/zkEnrollment');
const a = addDevice({ name: 'Assigned', ip: '192.0.2.1' }).id;
const b = addDevice({ name: 'Not assigned', ip: '192.0.2.2' }).id;
const roster = [{ uid: 1, employeeId: '1', name: 'Device Admin', role: 14 }, { uid: 20, employeeId: '20', name: 'Normal User', role: 0 }];
saveEmployees(a, roster); saveEmployees(b, roster);
const operator = createUser({ username: 'operator', password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices: [a] });
createUser({ username: 'other-operator', password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices: [a] });
createUser({ username: 'no-devices', password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices: [] });
const tokens = Object.fromEntries(['admin', 'operator', 'other-operator', 'no-devices']
  .map(username => [username, authenticate(username, process.env.INITIAL_ADMIN_PASSWORD).token]));
const connections = [], captures = [];
let releaseCapture;
const originalFactory = enrollment.createEnrollmentManager;
mock.method(enrollment, 'createEnrollmentManager', dependencies => originalFactory({ ...dependencies,
  withDevice: async (device, work) => { connections.push(device.id); return work({ id: device.id }); },
  read: async () => ({ users: roster, templates: new Map([['20:4', 'private-template-hash']]) }),
  readUsers: async () => ({ users: roster }),
  capture: async (device, input, control, options) => {
    const user = input.createEmployee ? { role: 0 } : roster.find(value => value.employeeId === input.employeeId);
    const permission = options.authorize();
    assertEnrollmentTarget(user, options.allowPrivilegedUsers && permission.allowPrivilegedUsers);
    captures.push({ deviceId: device.id, input, privileged: options.allowPrivilegedUsers });
    if (releaseCapture) await releaseCapture.gate;
    if (input.createEmployee) control.report({ employeeId: '21', employeeCreated: true });
    return { status: control.signal.aborted ? 'cancelled' : 'completed', message: 'Simulated verification', fingerprintStored: !control.signal.aborted,
      employeeCreated: input.createEmployee };
  },
}));
const app = require('./index');
let server, base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  releaseCapture?.resolve();
  await new Promise(resolve => server.close(resolve));
  mock.restoreAll(); db.close(); fs.rmSync(directory, { recursive: true, force: true });
});
async function request(route, { actor = 'operator', deviceId = a, method = 'GET', body } = {}) {
  const params = new URLSearchParams();
  if (deviceId !== null) params.set('deviceId', deviceId);
  if (route === '/api/device/fingerprints') params.set('employeeId', body?.employeeId || '20');
  const response = await fetch(`${base}${route}?${params}`, { method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}) },
    body: method === 'POST' || method === 'PUT' ? JSON.stringify(body || {}) : undefined });
  return { status: response.status, data: await response.json() };
}
const consent = { employeeId: '20', fingerIndex: 3, consent: true, confirmed: true };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('operator can inspect normal users and get the next ID on assigned clocks without receiving biometric bytes', async () => {
  const preview = await request('/api/device/fingerprints');
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.occupiedSlots, [4]);
  assert.equal(preview.data.employee.employeeId, '20');
  assert.equal(JSON.stringify(preview.data).includes('private-template-hash'), false);
  const next = await request('/api/device/enrollment-next-id');
  assert.equal(next.status, 200); assert.equal(next.data.employeeId, '21');
});

test('all enrollment routes require login and explicit assigned device identity before any clock access', async () => {
  const previous = connections.length;
  for (const [route, method] of [['/api/device/fingerprints', 'GET'], ['/api/device/enrollment-next-id', 'GET'],
    ['/api/device/enrollments', 'GET'], ['/api/device/enrollments', 'POST'],
    ['/api/device/enrollments/foreign', 'GET'], ['/api/device/enrollments/foreign/cancel', 'POST']]) {
    assert.equal((await request(route, { actor: null, method, body: consent })).status, 401);
    assert.equal((await request(route, { deviceId: null, method, body: consent })).status, 400);
    assert.equal((await request(route, { deviceId: b, method, body: consent })).status, 404);
    assert.equal((await request(route, { actor: 'no-devices', method, body: consent })).status, 404);
  }
  assert.equal(connections.length, previous);
});

test('operator can create and inspect their own capture job; forged roles and actor identity are ignored', async () => {
  const started = await request('/api/device/enrollments', { method: 'POST', body: { ...consent, role: 14, actorId: 'usr-admin', allowPrivilegedUsers: true } });
  assert.equal(started.status, 202);
  await settle();
  const job = await request(`/api/device/enrollments/${started.data.job.id}`);
  assert.equal(job.status, 200); assert.equal(job.data.job.status, 'completed');
  assert.equal(db.prepare('SELECT actor_id FROM enrollment_jobs WHERE id=?').get(started.data.job.id).actor_id, operator.id);
  assert.equal(captures.at(-1).privileged, false);
  assert.equal(captures.at(-1).input.role, undefined);
  assert.equal((await request('/api/device/enrollments')).data.job.id, started.data.job.id);
  assert.equal((await request(`/api/device/enrollments/${started.data.job.id}`, { actor: 'other-operator' })).status, 404);
  assert.equal((await request(`/api/device/enrollments/${started.data.job.id}/cancel`, { method: 'POST', actor: 'other-operator' })).status, 404);
  assert.equal((await request(`/api/device/enrollments/${started.data.job.id}`, { actor: 'admin' })).status, 200);
});

test('operator registration for a new collaborator uses automatic IDs and never grants administrator rights', async () => {
  const started = await request('/api/device/enrollments', { method: 'POST', body: { ...consent, createEmployee: true, name: 'New Normal User', employeeId: '1', role: 14 } });
  assert.equal(started.status, 202); await settle();
  const job = (await request(`/api/device/enrollments/${started.data.job.id}`)).data.job;
  assert.equal(job.status, 'completed'); assert.equal(job.employeeId, '21');
  assert.equal(captures.at(-1).input.employeeId, '');
  assert.equal(captures.at(-1).input.role, undefined);
  assert.equal(captures.at(-1).privileged, false);
});

test('operators cannot enroll device administrators through inspection or direct capture requests', async () => {
  const previous = captures.length;
  assert.equal((await request('/api/device/fingerprints', { body: { employeeId: '1' } })).status, 403);
  const started = await request('/api/device/enrollments', { method: 'POST', body: { ...consent, employeeId: '1', allowPrivilegedUsers: true } });
  assert.equal(started.status, 202); await settle();
  const job = (await request(`/api/device/enrollments/${started.data.job.id}`)).data.job;
  assert.equal(job.status, 'failed');
  assert.match(job.message, /Solo un administrador/);
  assert.equal(captures.length, previous);
  assert.equal((await request('/api/device/fingerprints', { actor: 'admin', body: { employeeId: '1' } })).status, 200);
});

test('operators can cancel their own active enrollment, but cannot cancel another actor capture', async () => {
  let resolve;
  releaseCapture = { gate: new Promise(done => { resolve = done; }), resolve: () => resolve() };
  const started = await request('/api/device/enrollments', { method: 'POST', body: consent });
  assert.equal(started.status, 202); await settle();
  try {
    assert.equal((await request(`/api/device/enrollments/${started.data.job.id}/cancel`, { method: 'POST', actor: 'other-operator' })).status, 404);
    assert.equal((await request('/api/device/enrollments', { actor: 'other-operator' })).data.job, null);
    assert.equal((await request(`/api/device/enrollments/${started.data.job.id}/cancel`, { method: 'POST' })).status, 200);
  } finally { releaseCapture.resolve(); releaseCapture = null; await settle(); }
  assert.equal((await request(`/api/device/enrollments/${started.data.job.id}`)).data.job.status, 'cancelled');
});

test('backup, restoration and portal administration stay restricted to administrators', async () => {
  const previous = connections.length;
  for (const [route, method] of [['/api/device/biometric-backups/history', 'GET'], ['/api/device/biometric-backups/download', 'POST'],
    ['/api/device/biometric-backups/recovery-key', 'GET'], ['/api/device/biometric-backups/preview', 'POST'],
    ['/api/device/biometric-backups/restore', 'POST'], ['/api/admin/users', 'GET']]) {
    assert.equal((await request(route, { method, body: { role: 14 } })).status, 403);
  }
  assert.equal(connections.length, previous);
});

test('revoking device assignment immediately denies inspection and enrollment on the next request', async () => {
  const previous = connections.length;
  updateUser(operator.id, { assignedDevices: [] });
  try {
    assert.equal((await request('/api/device/fingerprints')).status, 404);
    assert.equal((await request('/api/device/enrollments', { method: 'POST', body: consent })).status, 404);
  } finally { updateUser(operator.id, { assignedDevices: [a] }); }
  assert.equal(connections.length, previous);
});
