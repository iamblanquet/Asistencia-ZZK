const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asistencia-sql-test-'));
process.env.ASISTENCIA_DATA_DIR = dir;
const password = 'Test-SQL-Admin-29';
function fixture(name, value) { fs.writeFileSync(path.join(dir, name), JSON.stringify(value)); }
fixture('devices.db', [{ id: 'a', name: 'A', ip: '127.0.0.1', shiftEnd: '18:00' }, { id: 'b', name: 'B', ip: '127.0.0.2', shiftEnd: '15:00' }]);
fixture('users.db', [{ id: 'usr-admin', username: 'admin', role: 'admin', password: crypto.createHash('sha256').update(password).digest('hex'), assignedDevices: [] }]);
fixture('events.db', [
  { deviceId: 'a', employeeId: '1', employeeName: 'Ana A', timestamp: '2026-10-30T14:30:00Z' },
  { deviceId: 'b', employeeId: '1', employeeName: 'Beto B', timestamp: '2026-10-30T14:30:00Z' },
]);
fixture('employee_overrides.db', { '1': 'Nombre ambiguo' });
const { db } = require('./services/sqlite');
const devices = require('./services/db');
const events = require('./services/eventStore');
const auth = require('./services/auth');
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('migration isolates repeated employee IDs and retains ambiguous names for review', () => {
  assert.equal(devices.getEmployees('a')[0].name, 'Ana A');
  assert.equal(devices.getEmployees('b')[0].name, 'Beto B');
  assert.equal(events.getStoredEvents('a').length, 1);
  assert.equal(events.getStoredEvents('b').length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM migration_issues').get().n, 1);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('pre-sqlite-')));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('names and schedules change only for their biometric', () => {
  devices.updateEmployeeName('a', '1', 'Ana editada');
  assert.equal(devices.getEmployees('a')[0].name, 'Ana editada');
  assert.equal(devices.getEmployees('b')[0].name, 'Beto B');
  assert.equal(events.getStoredEvents('a')[0].employeeName, 'Ana editada');
  devices.updateDevice('a', { shiftEnd: '19:00' });
  assert.equal(devices.getDeviceById('b').shiftEnd, '15:00');
  assert.throws(() => devices.updateEmployeeName('', '1', 'Wrong'));
});
test('events deduplicate within a device across sources, never across devices', () => {
  const event = { employeeId: '1', timestamp: '2026-10-30T18:00:00Z' };
  assert.equal(events.addStoredEvents('a', [event], 'import').length, 1);
  assert.equal(events.addStoredEvents('a', [event], 'device').length, 0);
  assert.equal(events.addStoredEvents('b', [event], 'device').length, 1);
  assert.throws(() => events.addStoredEvents('missing', [event]));
  assert.equal(events.getStoredEvents('a').length, 2);
});
test('migration is idempotent and SQL data survives reopening', () => {
  fixture('events.db', []);
  const result = execFileSync(process.execPath, ['-e', "console.log(require('./services/eventStore').getStoredEvents('a').length)"], { cwd: __dirname, env: { ...process.env, ASISTENCIA_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(result.trim(), '2');
});
test('user assignments are transactional and preserve existing login', () => {
  assert.ok(auth.authenticate('admin', password));
  assert.throws(() => auth.createUser({ username: 'invalid', password, assignedDevices: ['missing'] }));
  assert.equal(auth.getUsers().some(u => u.username === 'invalid'), false);
});
test('API requires biometric identity and enforces operator assignments', async () => {
  const operator = auth.createUser({ username: 'operator', password, assignedDevices: ['a'] });
  const token = auth.authenticate('operator', password).token;
  const app = require('./index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    const list = await (await fetch(base + '/api/devices', { headers })).json();
    assert.deepEqual(list.map(d => d.id), ['a']);
    assert.equal((await fetch(base + '/api/events', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/events?deviceId=b', { headers })).status, 404);
    assert.equal((await fetch(base + '/api/employees/1?deviceId=b', { headers, method: 'PUT', body: JSON.stringify({ name: 'Wrong' }) })).status, 403);
    assert.equal((await fetch(base + '/api/employees/1', { headers, method: 'PUT', body: JSON.stringify({ name: 'Wrong' }) })).status, 400);
    assert.equal((await fetch(base + '/api/employees/1?deviceId=a', { headers, method: 'PUT', body: JSON.stringify({ name: 'Allowed' }) })).status, 200);
    assert.equal(devices.getEmployees('b')[0].name, 'Beto B');
  } finally { await new Promise(resolve => server.close(resolve)); auth.deleteUser(operator.id); }
});
test('deleting a biometric hides it without deleting its historical data', () => {
  devices.deleteDevice('b');
  assert.equal(devices.getDeviceById('b'), null);
  assert.equal(events.getStoredEvents('b').length, 2);
});
