const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-general-schedules-'));
process.env.ASISTENCIA_DATA_DIR = dir;
process.env.INITIAL_ADMIN_PASSWORD = 'Schedule-History-Test-42';
fs.writeFileSync(path.join(dir, 'devices.db'), JSON.stringify([
  { id: 'a', name: 'A', ip: '127.0.0.1', shiftStart: '08:30', shiftEnd: '18:00', graceMinutes: 0 },
  { id: 'b', name: 'B', ip: '127.0.0.2', shiftStart: '06:00', shiftEnd: '15:00' },
]));
const { db } = require('./services/sqlite');
const { addDevice, getDeviceById, updateDevice, saveEmployees } = require('./services/db');
const { initializeGeneralSchedules, getGeneralSchedule, saveGeneralSchedule, currentGeneralSettings,
  getEmployeeSchedule, assignEmployeeSchedule, saveScheduleGroup, listScheduleGroups } = require('./services/reportSchedules');
const { getSavedAttendance } = require('./services/attendanceStore');
const { authenticate, createUser } = require('./services/auth');
saveEmployees('a', [{ employeeId: '1', name: 'Ana' }, { employeeId: '2', name: 'Luis' }]);
saveEmployees('b', [{ employeeId: '1', name: 'Beto' }]);
const settings = { shiftStart: '07:00', shiftEnd: '16:00', satShiftStart: '07:00', satShiftEnd: '12:00', graceMinutes: 15 };
after(() => { mock.restoreAll(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('migration captures each original general schedule once, preserving zero tolerance and raw device config', () => {
  const before = db.prepare('SELECT config FROM devices ORDER BY id').all();
  assert.equal(getGeneralSchedule('a').versions[0].effectiveFrom, '0001-01-01');
  assert.equal(getGeneralSchedule('a').versions[0].settings.shiftStart, '08:30');
  assert.equal(getGeneralSchedule('a').versions[0].settings.graceMinutes, 0);
  assert.equal(getGeneralSchedule('b').versions[0].settings.shiftStart, '06:00');
  initializeGeneralSchedules(); initializeGeneralSchedules();
  assert.equal(getGeneralSchedule('a').versions.length, 1);
  assert.deepEqual(db.prepare('SELECT config FROM devices ORDER BY id').all(), before);
});

test('general changes use effective dates without touching legacy config, old versions or other devices', () => {
  const before = db.prepare('SELECT config FROM devices WHERE id=?').get('a').config;
  const general = saveGeneralSchedule('a', { revision: 1, effectiveFrom: '2026-11-05', settings }, 'admin');
  assert.equal(general.versions.length, 2);
  assert.equal(currentGeneralSettings('a', '2026-11-04').shiftStart, '08:30');
  assert.equal(currentGeneralSettings('a', '2026-11-05').shiftStart, '07:00');
  assert.equal(currentGeneralSettings('b', '2026-11-05').shiftStart, '06:00');
  assert.equal(db.prepare('SELECT config FROM devices WHERE id=?').get('a').config, before);
  assert.equal(getSavedAttendance(getDeviceById('a')).generalReportSchedule.revision, 2);
  assert.equal(JSON.parse(db.prepare('SELECT details FROM report_schedule_audit ORDER BY id DESC LIMIT 1').get().details).action, 'general_schedule');
});

test('baseline, invalid input and stale revisions cannot overwrite general history', () => {
  const before = JSON.stringify(getGeneralSchedule('a'));
  for (const input of [
    { effectiveFrom: '0001-01-01' }, { effectiveFrom: '0000-01-01' }, { effectiveFrom: '2026-02-30' },
    { revision: 1 }, { settings: { ...settings, shiftEnd: '25:00' } },
  ]) assert.throws(() => saveGeneralSchedule('a', { revision: 2, effectiveFrom: '2026-11-06', settings, ...input }, 'admin'));
  assert.equal(JSON.stringify(getGeneralSchedule('a')), before);
  assert.throws(() => updateDevice('a', { name: 'Should roll back', shiftStart: '12:00' }), error => error.statusCode === 400);
  assert.equal(getDeviceById('a').name, 'A');
});

test('future general versions remain scheduled and identity edits do not replace the original baseline', () => {
  const current = currentGeneralSettings('a');
  const general = getGeneralSchedule('a');
  saveGeneralSchedule('a', { revision: general.revision, effectiveFrom: '2099-01-01', settings: { ...settings, shiftEnd: '19:00' } }, 'admin');
  assert.equal(getDeviceById('a').shiftEnd, current.shiftEnd);
  assert.equal(currentGeneralSettings('a', '2099-01-01').shiftEnd, '19:00');
  updateDevice('a', { name: 'A edited', ...current });
  assert.equal(getGeneralSchedule('a').versions[0].settings.shiftStart, '08:30');
  assert.equal(getGeneralSchedule('a').versions.length, 3);
  const created = addDevice({ name: 'C', ip: '127.0.0.3', ...settings });
  assert.equal(getGeneralSchedule(created.id).versions[0].settings.shiftStart, '07:00');
});

test('original and scheduled general versions survive process restart unchanged', () => {
  const before = getGeneralSchedule('a');
  const result = JSON.parse(execFileSync(process.execPath, ['-e', "require('./services/db');console.log(JSON.stringify(require('./services/reportSchedules').getGeneralSchedule('a')))"], { cwd: __dirname, env: process.env, encoding: 'utf8' }));
  assert.deepEqual(result, before);
});

let group;
test('row assignment keeps prior and future history, touches only the chosen employee and guards bulk editors', () => {
  group = saveScheduleGroup('a', null, { name: 'Temprano', effectiveFrom: '2026-11-04', settings, employeeIds: [] }, 'admin');
  let assignment = getEmployeeSchedule('a', '1');
  assignment = assignEmployeeSchedule('a', '1', { revision: assignment.revision, groupId: group.id, effectiveFrom: '2026-11-10' }, 'admin');
  const stale = assignment.revision;
  assignment = assignEmployeeSchedule('a', '1', { revision: assignment.revision, groupId: null, effectiveFrom: '2026-11-20' }, 'admin');
  assignment = assignEmployeeSchedule('a', '1', { revision: assignment.revision, groupId: group.id, effectiveFrom: '2026-11-05' }, 'admin');
  assert.deepEqual(assignment.assignments.map(value => value.effectiveFrom), ['2026-11-05', '2026-11-10', '2026-11-20']);
  assert.deepEqual(getEmployeeSchedule('a', '2').assignments, []);
  assert.deepEqual(getEmployeeSchedule('b', '1').assignments, []);
  assert.throws(() => assignEmployeeSchedule('a', '1', { revision: stale, groupId: null, effectiveFrom: '2026-11-08' }, 'admin'), error => error.statusCode === 409);
  assert.throws(() => saveScheduleGroup('a', group.id, { name: 'Temprano', revision: group.revision, settings, employeeIds: [], effectiveFrom: '2026-11-05' }, 'admin'), error => error.statusCode === 409);
  group = listScheduleGroups('a').find(value => value.id === group.id);
});

test('row assignments reject absent employees, foreign groups, invalid dates and schedules before their first version', () => {
  const current = getEmployeeSchedule('a', '1');
  for (const value of [
    { groupId: 'unknown' }, { groupId: group.id, effectiveFrom: '2026-11-03' }, { effectiveFrom: '2026-02-30' }, { groupId: undefined },
  ]) assert.throws(() => assignEmployeeSchedule('a', '1', { revision: current.revision, groupId: null, effectiveFrom: '2026-11-06', ...value }, 'admin'));
  assert.throws(() => assignEmployeeSchedule('b', '1', { revision: getEmployeeSchedule('b', '1').revision, groupId: group.id, effectiveFrom: '2026-11-06' }, 'admin'));
  assert.throws(() => getEmployeeSchedule('a', '99'), error => error.statusCode === 404);
  assert.deepEqual(getEmployeeSchedule('a', '1'), current);
});

test('general and row-assignment API enforce device permissions and never connect to hardware', async () => {
  let connections = 0;
  mock.method(require('zklib-js').prototype, 'createSocket', async () => { connections++; throw new Error('Hardware access forbidden'); });
  const app = require('./index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  createUser({ username: 'scheduler', password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices: ['a'] });
  const auth = authenticate('scheduler', process.env.INITIAL_ADMIN_PASSWORD);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, method = 'GET', body, token = auth.token) {
    const response = await fetch(base + url, { method, headers: { Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  try {
    const generalPath = '/api/device/report-schedules/general';
    const rowPath = '/api/employees/1/report-schedule';
    assert.equal((await request(generalPath + '?deviceId=a', 'PUT', null, null)).status, 401);
    assert.equal((await request(generalPath, 'PUT', {})).status, 400);
    assert.equal((await request(generalPath + '?deviceId=b', 'PUT', {})).status, 404);
    assert.equal((await request(rowPath + '?deviceId=b')).status, 404);
    assert.equal((await request(rowPath + '?deviceId=b', 'PUT', {})).status, 404);
    assert.equal((await request(rowPath)).status, 400);
    assert.equal((await request('/api/employees/99/report-schedule?deviceId=a')).status, 404);
    const snapshot = (await request('/api/device/report-schedules?deviceId=a')).data;
    const saved = await request(generalPath + '?deviceId=a', 'PUT', { revision: snapshot.generalReportSchedule.revision, effectiveFrom: '2026-11-12', settings });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.generalReportSchedule.versions.length, 4);
    const row = await request(rowPath + '?deviceId=a');
    assert.equal(row.status, 200);
    assert.equal(row.data.employee.employeeId, '1');
    assert.equal((await request(rowPath + '?deviceId=a', 'PUT', { revision: row.data.assignment.revision, effectiveFrom: '2026-11-15', groupId: null })).status, 200);
    assert.equal((await request('/api/devices/a', 'PUT', { shiftStart: '14:00' })).status, 400);
    assert.ok((await request('/api/events?deviceId=a')).data.generalReportSchedule.versions.length);
    assert.ok((await request('/api/employees?deviceId=a')).data.generalReportSchedule.versions.length);
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
