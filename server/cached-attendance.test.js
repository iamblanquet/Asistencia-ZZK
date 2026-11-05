const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-cache-test-'));
process.env.ASISTENCIA_DATA_DIR = dir;
const password = 'Cache-Test-Password-50';
fs.writeFileSync(path.join(dir, 'devices.db'), JSON.stringify([
  { id: 'a', ip: '127.0.0.1', name: 'A', port: 4370 }, { id: 'b', ip: '127.0.0.2', name: 'B', port: 4370 },
]));
fs.writeFileSync(path.join(dir, 'users.db'), JSON.stringify([{ id: 'usr-admin', username: 'admin', role: 'admin', password: crypto.createHash('sha256').update(password).digest('hex'), assignedDevices: [] }]));
const { db } = require('./services/sqlite');
const { addStoredEvents } = require('./services/eventStore');
const { getSavedAttendance } = require('./services/attendanceStore');
const { getDeviceById } = require('./services/db');
const { authenticate, createUser } = require('./services/auth');
addStoredEvents('a', [
  { employeeId: '1', employeeName: 'Ana', timestamp: '2026-11-01T08:30:00-06:00' },
  { employeeId: '2', employeeName: 'Otro', timestamp: '2026-11-02T08:30:00-06:00' },
]);
addStoredEvents('b', [{ employeeId: '1', employeeName: 'Beto', timestamp: '2026-11-01T08:30:00-06:00' }]);
const ZKLib = require('zklib-js');
let connectCalls = 0;
let online = false;
let failure = null;
let reportedLogCount = 1;
let waitForRead = null;
let readStarted = null;
mock.method(ZKLib.prototype, 'createSocket', async function () {
  connectCalls++;
  if (!online) throw new Error('Reloj desconectado');
  this.connectionType = 'udp';
});
mock.method(ZKLib.prototype, 'disconnect', async () => {});
mock.method(ZKLib.prototype, 'getInfo', async () => ({ logCounts: reportedLogCount }));
mock.method(ZKLib.prototype, 'getUsers', async function () {
  if (readStarted) readStarted();
  if (waitForRead) await waitForRead;
  return { data: [{ uid: '1', userId: '1', name: this.ip === '127.0.0.1' ? 'Ana' : 'Beto' }] };
});
mock.method(ZKLib.prototype, 'getAttendances', async () => {
  if (failure) return { data: [], err: new Error(failure) };
  return { data: [{ deviceUserId: '1', recordTime: new Date('2026-11-02T18:50:00-06:00') }] };
});
const app = require('./index');
let server, base, headers;
before(async () => {
  const token = authenticate('admin', password).token;
  headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  mock.restoreAll();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function request(url, method = 'GET', auth = headers) {
  const response = await fetch(base + url, { method, headers: auth });
  return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
}
test('history and employee queries work offline and never contact the clock', async () => {
  const history = await request('/api/events?deviceId=a');
  assert.equal(history.status, 200);
  assert.equal(history.data.source, 'database');
  assert.equal(history.data.events.length, 2);
  assert.equal(history.data.fetchedAt, null);
  assert.equal((await request('/api/employees?deviceId=a')).data.employees.length, 2);
  assert.equal(connectCalls, 0);
});
test('database queries filter dates and employees without crossing biometric data', async () => {
  const history = await request('/api/events?deviceId=a&from=2026-11-02&to=2026-11-02&employeeId=2');
  assert.equal(history.data.events.length, 1);
  assert.equal(history.data.events[0].deviceId, 'a');
  const other = await request('/api/events?deviceId=b');
  assert.equal(other.data.events[0].employeeName, 'Beto');
  assert.equal((await request('/api/events?deviceId=a&from=2026-02-30')).status, 400);
  assert.equal((await request('/api/events?deviceId=a&from=2026-11-02&to=2026-11-01')).status, 400);
  assert.equal(connectCalls, 0);
});
test('only explicit POST sync calls the clock and stores last successful sync', async () => {
  online = true;
  assert.equal((await request('/api/device/sync?deviceId=a')).status, 404);
  assert.equal(connectCalls, 0);
  const result = await request('/api/device/sync?deviceId=a', 'POST');
  assert.equal(result.status, 200);
  assert.equal(connectCalls, 1);
  assert.ok(result.data.fetchedAt);
  const history = await request('/api/events?deviceId=a');
  assert.equal(history.data.events.length, 3);
  assert.equal(history.data.fetchedAt, result.data.fetchedAt);
  const again = await request('/api/events?deviceId=a');
  assert.equal(again.data.fetchedAt, result.data.fetchedAt);
  assert.equal(connectCalls, 1);
});
test('failed synchronization preserves saved history and last success date', async () => {
  const old = getSavedAttendance(getDeviceById('a'));
  online = false;
  const result = await request('/api/device/sync?deviceId=a', 'POST');
  assert.equal(result.status, 503);
  const saved = await request('/api/events?deviceId=a');
  assert.equal(saved.status, 200);
  assert.equal(saved.data.events.length, old.events.length);
  assert.equal(saved.data.fetchedAt, old.fetchedAt);
  assert.ok(saved.data.sync.lastError);
});
test('partial download failures are not recorded as a successful sync', async () => {
  online = true;
  failure = 'Incomplete download';
  const old = getSavedAttendance(getDeviceById('a'));
  assert.equal((await request('/api/device/sync?deviceId=a', 'POST')).status, 503);
  assert.equal(getSavedAttendance(getDeviceById('a')).fetchedAt, old.fetchedAt);
  failure = null;
});

test('a silently truncated history cannot overwrite a successful synchronization', async () => {
  const old = getSavedAttendance(getDeviceById('a'));
  reportedLogCount = 2;
  try {
    const response = await request('/api/device/sync?deviceId=a', 'POST');
    assert.equal(response.status, 503);
    const saved = getSavedAttendance(getDeviceById('a'));
    assert.equal(saved.fetchedAt, old.fetchedAt);
    assert.equal(saved.events.length, old.events.length);
    assert.match(saved.sync.lastError, /historial completo/);
  } finally {
    reportedLogCount = 1;
  }
});
test('history remains available while one shared synchronization is running', async () => {
  const before = connectCalls;
  let release;
  waitForRead = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { readStarted = resolve; });
  const first = request('/api/device/sync?deviceId=a', 'POST');
  await started;
  const second = request('/api/device/sync?deviceId=a', 'POST');
  try {
    assert.equal((await request('/api/events?deviceId=a')).status, 200);
    assert.equal(connectCalls, before + 1);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(connectCalls, before + 1);
  assert.equal(getSavedAttendance(getDeviceById('a')).events.length, 3);
  waitForRead = null;
  readStarted = null;
});
test('sync timestamps survive restarting the process', () => {
  const saved = getSavedAttendance(getDeviceById('a')).fetchedAt;
  const output = execFileSync(process.execPath, ['-e', "const {getSavedAttendance}=require('./services/attendanceStore'); const {getDeviceById}=require('./services/db'); console.log(getSavedAttendance(getDeviceById('a')).fetchedAt)"], { cwd: __dirname, encoding: 'utf8', env: process.env });
  assert.equal(output.trim(), saved);
});
test('operators cannot synchronize an unassigned clock or without device identity', async () => {
  createUser({ username: 'operator', password, assignedDevices: ['a'] });
  const auth = { ...headers, Authorization: 'Bearer ' + authenticate('operator', password).token };
  const before = connectCalls;
  assert.equal((await request('/api/device/sync?deviceId=b', 'POST', auth)).status, 404);
  assert.equal((await request('/api/device/sync', 'POST', auth)).status, 400);
  assert.equal(connectCalls, before);
});

test('backups remain administrator-only while enrollment and user management are device-scoped', async () => {
  createUser({ username: 'finger-operator', password, assignedDevices: ['a'] });
  const auth = { ...headers, Authorization: 'Bearer ' + authenticate('finger-operator', password).token };
  const before = connectCalls;
  for (const [path, method] of [['/api/device/biometric-backups/download?deviceId=a', 'POST'], ['/api/device/biometric-backups/preview?deviceId=a', 'POST'],
    ['/api/device/biometric-backups/restore?deviceId=a', 'POST'], ['/api/device/biometric-backups/history?deviceId=a', 'GET'],
    ['/api/device/biometric-backups/recovery-key?deviceId=a', 'GET']]) {
    assert.equal((await request(path, method, auth)).status, 403);
  }
  assert.equal((await request('/api/device/enrollments', 'POST')).status, 400);
  assert.equal((await request('/api/device/enrollment-next-id')).status, 400);
  assert.equal((await request('/api/device/enrollments?deviceId=a', 'POST')).status, 400);
  assert.equal((await request('/api/device/enrollments/unknown?deviceId=b')).status, 404);
  assert.equal((await request('/api/device/enrollments?deviceId=a')).data.job, null);
  assert.equal((await request('/api/device/enrollments?deviceId=a', 'GET', auth)).data.job, null);
  assert.equal((await request('/api/device/enrollments/unknown?deviceId=a', 'GET', auth)).status, 404);
  assert.equal((await request('/api/device/enrollments/unknown/cancel?deviceId=a', 'POST', auth)).status, 404);
  for (const [path, method] of [['/api/device/fingerprints?deviceId=b&employeeId=1', 'GET'],
    ['/api/device/enrollment-next-id?deviceId=b', 'GET'], ['/api/device/enrollments?deviceId=b', 'GET'],
    ['/api/device/enrollments?deviceId=b', 'POST'], ['/api/device/enrollments/unknown?deviceId=b', 'GET'],
    ['/api/device/enrollments/unknown/cancel?deviceId=b', 'POST']]) assert.equal((await request(path, method, auth)).status, 404);
  assert.equal(connectCalls, before);
});

test('backup endpoints require an authenticated administrator and an explicit existing biometric', async () => {
  const before = connectCalls;
  assert.equal((await request('/api/device/biometric-backups/history?deviceId=a', 'GET', {})).status, 401);
  assert.equal((await request('/api/device/biometric-backups/history')).status, 400);
  assert.equal((await request('/api/device/biometric-backups/history?deviceId=unknown')).status, 404);
  assert.deepEqual((await request('/api/device/biometric-backups/history?deviceId=b')).data.actions, []);
  const invalid = await fetch(base + '/api/device/biometric-backups/download?deviceId=a', { method: 'POST', headers, body: JSON.stringify({ confirmed: false }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).detail, undefined);
  assert.equal(connectCalls, before);
});
