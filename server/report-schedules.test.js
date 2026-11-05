const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-schedules-'));
process.env.ASISTENCIA_DATA_DIR = dir;
process.env.INITIAL_ADMIN_PASSWORD = 'Schedules-Test-Password-42';
const { db } = require('./services/sqlite');
const { saveEmployees, getEmployees, addDevice, getDeviceById } = require('./services/db');
const { saveScheduleGroup, listScheduleGroups } = require('./services/reportSchedules');
const { getSavedAttendance } = require('./services/attendanceStore');
const { addStoredEvents } = require('./services/eventStore');
const { authenticate, createUser } = require('./services/auth');
const a = 'dev-default';
const b = addDevice({ name: 'B', ip: '127.0.0.2' }).id;
saveEmployees(a, [{ employeeId: '1', name: 'Ana' }, { employeeId: '2', name: 'Luis' }, { employeeId: '3', name: 'Sara' }]);
saveEmployees(b, [{ employeeId: '1', name: 'Beto' }]);
const settings = { shiftStart: '07:00', shiftEnd: '16:00', satShiftStart: '07:00', satShiftEnd: '12:00', graceMinutes: 15 };
const input = { name: 'Temprano', effectiveFrom: '2026-11-04', settings, employeeIds: ['1', '2'] };
let group;
after(() => { mock.restoreAll(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('bulk groups are isolated by biometric and leave unassigned employees on the general schedule', () => {
  group = saveScheduleGroup(a, null, input, 'admin');
  assert.equal(listScheduleGroups(a).length, 1);
  assert.equal(listScheduleGroups(b).length, 0);
  const employees = getEmployees(a);
  assert.equal(employees[0].scheduleAssignments[0].groupId, group.id);
  assert.equal(employees[1].scheduleAssignments[0].groupId, group.id);
  assert.deepEqual(employees[2].scheduleAssignments, []);
  assert.deepEqual(getEmployees(b)[0].scheduleAssignments, []);
  assert.deepEqual(getSavedAttendance(getDeviceById(a)).reportScheduleGroups, [group]);
});

test('group edits and bulk reassignment retain effective-dated history and audit', () => {
  group = saveScheduleGroup(a, group.id, { ...input, effectiveFrom: '2026-11-10',
    settings: { ...settings, shiftStart: '06:00' }, employeeIds: ['2', '3'], revision: group.revision }, 'operator');
  assert.deepEqual(group.versions.map(v => v.effectiveFrom), ['2026-11-04', '2026-11-10']);
  assert.deepEqual(getEmployees(a)[0].scheduleAssignments, [
    { effectiveFrom: '2026-11-04', groupId: group.id }, { effectiveFrom: '2026-11-10', groupId: null },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_schedule_audit').get().n, 2);
  assert.equal(JSON.parse(db.prepare('SELECT details FROM report_schedule_audit ORDER BY id DESC LIMIT 1').get().details).changes.length, 2);
});

test('moving a group member updates source revision and rejects stale edits atomically', () => {
  const oldRevision = group.revision;
  const other = saveScheduleGroup(a, null, { ...input, name: 'Oficina', effectiveFrom: '2026-11-11', employeeIds: ['2'] }, 'admin');
  group = listScheduleGroups(a).find(value => value.id === group.id);
  assert.equal(group.revision, oldRevision + 1);
  const before = JSON.stringify(getEmployees(a));
  assert.throws(() => saveScheduleGroup(a, group.id, { ...input, revision: oldRevision }, 'admin'), error => error.statusCode === 409);
  assert.equal(JSON.stringify(getEmployees(a)), before);
  assert.equal(getEmployees(a)[1].scheduleAssignments.at(-1).groupId, other.id);
});

test('invalid schedules and foreign employee assignments never partially write', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM report_schedule_audit').get().n;
  for (const bad of [
    { effectiveFrom: '2026-02-30' }, { effectiveFrom: 'invalid' }, { name: '' },
    { name: 'temprano' }, { employeeIds: ['99'] }, { employeeIds: ['1', 2] },
    { settings: { ...settings, shiftStart: '25:00' } },
    { settings: { ...settings, shiftEnd: settings.shiftStart } },
    { settings: { ...settings, graceMinutes: -1 } }, { settings: { ...settings, graceMinutes: 1.5 } },
  ]) assert.throws(() => saveScheduleGroup(a, null, { ...input, ...bad }, 'admin'));
  assert.throws(() => saveScheduleGroup(b, group.id, { ...input, employeeIds: ['1'], revision: group.revision }, 'admin'), error => error.statusCode === 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM report_schedule_audit').get().n, before);
});

test('roster sync and process restarts preserve group membership, including historical employees', () => {
  const before = getEmployees(a).map(e => e.scheduleAssignments);
  saveEmployees(a, [{ employeeId: '1', name: 'Ana nueva' }]);
  assert.deepEqual(getEmployees(a).map(e => e.scheduleAssignments), before);
  const result = JSON.parse(execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./services/db').getEmployees('dev-default').map(e=>e.scheduleAssignments)))"], { cwd: __dirname, env: process.env, encoding: 'utf8' }));
  assert.deepEqual(result, before);
});

test('overnight query includes edge punches separately without changing the calendar log', () => {
  addStoredEvents(a, [
    { employeeId: '1', timestamp: '2026-11-03T22:00:00' },
    { employeeId: '1', timestamp: '2026-11-04T06:50:00' },
    { employeeId: '1', timestamp: '2026-11-04T22:00:00' },
    { employeeId: '1', timestamp: '2026-11-05T06:50:00' },
  ]);
  const snapshot = getSavedAttendance(getDeviceById(a), { from: '2026-11-04', to: '2026-11-04', includeScheduleEdges: true });
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.boundaryEvents.length, 2);
  assert.ok(snapshot.events.every(e => e.localDate === '2026-11-04'));
  assert.equal(getSavedAttendance(getDeviceById(a), { from: '2026-11-04', to: '2026-11-04' }).boundaryEvents.length, 0);
});

test('schedule API enforces device access and modifies only SQL, with no clock connections', async () => {
  let connections = 0;
  mock.method(require('zklib-js').prototype, 'createSocket', async () => { connections++; throw new Error('No hardware access allowed'); });
  const app = require('./index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  createUser({ username: 'scheduler', password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices: [a] });
  const token = authenticate('scheduler', process.env.INITIAL_ADMIN_PASSWORD).token;
  async function request(url, method = 'GET', body, auth = token) {
    const response = await fetch(base + url, { method, headers: { Authorization: auth ? `Bearer ${auth}` : '', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  try {
    assert.equal((await request('/api/device/report-schedules')).status, 400);
    assert.equal((await request(`/api/device/report-schedules?deviceId=${b}`)).status, 404);
    assert.equal((await request(`/api/device/report-schedules?deviceId=${a}`, 'GET', null, null)).status, 401);
    const created = await request(`/api/device/report-schedules?deviceId=${a}`, 'POST', { ...input, name: 'Operador', employeeIds: ['1'] });
    assert.equal(created.status, 201);
    assert.equal(created.data.group.name, 'Operador');
    const denied = await request(`/api/device/report-schedules/${created.data.group.id}?deviceId=${b}`, 'PUT', { ...input, revision: 1 });
    assert.equal(denied.status, 404);
    const saved = await request(`/api/device/report-schedules?deviceId=${a}`);
    assert.equal(saved.status, 200);
    assert.ok(saved.data.employees[0].scheduleAssignments.length);
    const history = await request(`/api/events?deviceId=${a}&from=2026-11-04&to=2026-11-04&includeScheduleEdges=1`);
    assert.equal(history.data.boundaryEvents.length, 2);
    assert.equal(history.data.reportScheduleGroups.length, saved.data.groups.length);
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
