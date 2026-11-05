const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-sundays-'));
process.env.ASISTENCIA_DATA_DIR = directory;
process.env.INITIAL_ADMIN_PASSWORD = 'Sunday-Schedule-Test-42';
const { db } = require('./services/sqlite');
const { addDevice, getDeviceById, updateDevice, saveEmployees, getEmployees } = require('./services/db');
const { getGeneralSchedule, saveGeneralSchedule, saveScheduleGroup, listScheduleGroups } = require('./services/reportSchedules');
const helpers = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8')).toString('base64'));
const settings = { shiftStart: '08:00', shiftEnd: '17:00', satShiftStart: '08:00', satShiftEnd: '13:00', graceMinutes: 15 };
const enabled = { ...settings, sundayEnabled: true, sunShiftStart: '07:00', sunShiftEnd: '12:00' };
const a = addDevice({ name: 'Sunday A', ip: '127.0.0.2', ...settings }).id;
const b = addDevice({ name: 'Sunday B', ip: '127.0.0.3', ...settings }).id;
saveEmployees(a, [{ employeeId: '1', name: 'Ana' }, { employeeId: '2', name: 'Luis' }]);
saveEmployees(b, [{ employeeId: '1', name: 'Beto' }]);
const events = (date, times, id = '1') => times.map(time => ({ employeeId: id, timestamp: `${date}T${time}` }));
after(() => { mock.restoreAll(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('disabled Sundays retain all punches and worked time without any incident or automatic overtime', async () => {
  const { buildDailySummary, buildEmployeeTotals, filterAndSortDailyRows, enrichAttendanceEvents } = await helpers;
  const input = events('2026-11-08', ['09:00', '09:02', '20:50']);
  const original = JSON.stringify(input);
  const schedule = { ...enabled, sundayEnabled: false };
  const [row] = buildDailySummary(input, [], schedule);
  assert.equal(row.status, 'Sin horario');
  assert.equal(row.workedMinutes, 710);
  assert.equal(row.punchCount, 3);
  assert.equal(row.duplicatePunchCount, 1);
  assert.equal(row.isScheduled, false);
  assert.equal(row.shiftStart, null);
  assert.equal(row.shiftEnd, null);
  for (const field of ['lateMinutes', 'earlyLeaveMinutes', 'overtimeMinutes', 'scheduledMinutes']) assert.equal(row[field], 0);
  for (const field of ['isLate', 'isEarlyLeave', 'isIncomplete']) assert.equal(row[field], false);
  const total = buildEmployeeTotals([row])[0];
  assert.equal(total.workedMinutes, 710);
  assert.equal(total.incompleteDays + total.lateCount + total.earlyLeaveCount + total.overtimeMinutes, 0);
  assert.equal(filterAndSortDailyRows([row], 'Sin horario').length, 1);
  assert.deepEqual(enrichAttendanceEvents(input, [], schedule).map(value => value.eventType), ['Entrada', 'Marcación', 'Salida']);
  assert.equal(JSON.stringify(input), original);
  const [single] = buildDailySummary(events('2026-11-08', ['09:00']), [], schedule);
  assert.equal(single.status, 'Sin horario');
  assert.equal(single.isIncomplete, false);
  assert.equal(single.lastPunch, null);
  assert.deepEqual(buildDailySummary([], [], schedule), []);
});

test('enabled Sundays use their own hours, entry grace and daily 50-minute overtime threshold', async () => {
  const { buildDailySummary } = await helpers;
  const calculate = times => buildDailySummary(events('2026-11-08', times), [], enabled)[0];
  const row = calculate(['07:15', '12:50']);
  assert.equal(row.shiftStart, '07:00');
  assert.equal(row.shiftEnd, '12:00');
  assert.equal(row.scheduledMinutes, 300);
  assert.equal(row.isLate, false);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(calculate(['07:00', '12:49:59']).overtimeMinutes, 0);
  assert.equal(calculate(['07:16', '11:59']).isLate, true);
  assert.equal(calculate(['07:16', '11:59']).earlyLeaveMinutes, 1);
  assert.equal(calculate(['07:16', '11:59']).status, 'Retardo + S.Temp.');
  const [monday] = buildDailySummary(events('2026-11-09', ['08:00', '17:00']), [], enabled);
  const [saturday] = buildDailySummary(events('2026-11-07', ['08:00', '13:00']), [], enabled);
  assert.equal(monday.scheduledMinutes, 540);
  assert.equal(saturday.scheduledMinutes, 300);
});

test('Sunday night shifts finish on Monday, and Saturday night exits survive disabled Sundays', async () => {
  const { buildDailySummary } = await helpers;
  const sundayNight = { ...enabled, sunShiftStart: '22:00', sunShiftEnd: '06:00' };
  const [row] = buildDailySummary([...events('2026-11-08', ['22:00']), ...events('2026-11-09', ['06:50'])], [], sundayNight);
  assert.equal(row.dateKey, '2026-11-08');
  assert.equal(row.workedMinutes, 530);
  assert.equal(row.overtimeMinutes, 60);
  const saturdayNight = { ...enabled, sundayEnabled: false, satShiftStart: '22:00', satShiftEnd: '06:00' };
  const rows = buildDailySummary([...events('2026-11-07', ['22:00']), ...events('2026-11-08', ['06:50', '12:00', '18:00'])], [], saturdayNight);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dateKey, '2026-11-07');
  assert.equal(rows[0].overtimeMinutes, 60);
  assert.equal(rows[1].status, 'Sin horario');
  assert.equal(rows[1].workedMinutes, 360);
});

test('legacy Sunday calculations and versions remain intact when a new general version disables Sunday', async () => {
  const { buildDailySummary } = await helpers;
  const baseline = db.prepare('SELECT * FROM report_general_schedule_versions WHERE device_id=?').all('dev-default');
  const config = db.prepare('SELECT config FROM devices WHERE id=?').get('dev-default').config;
  const general = getGeneralSchedule('dev-default');
  saveGeneralSchedule('dev-default', { revision: general.revision, effectiveFrom: '2026-11-06', settings: { ...settings, sundayEnabled: false } }, 'admin');
  const schedule = { ...settings, generalReportSchedule: getGeneralSchedule('dev-default') };
  const rows = buildDailySummary([...events('2026-11-01', ['08:00', '17:00']), ...events('2026-11-08', ['08:00', '17:00'])], [], schedule);
  assert.equal(rows[0].isScheduled, true);
  assert.equal(rows[0].scheduledMinutes, 540);
  assert.equal(rows[1].status, 'Sin horario');
  assert.deepEqual(db.prepare('SELECT * FROM report_general_schedule_versions WHERE device_id=? AND effective_from=?').all('dev-default', '0001-01-01'), baseline);
  assert.equal(db.prepare('SELECT config FROM devices WHERE id=?').get('dev-default').config, config);
});

test('new groups and devices default to Sunday off and retain effective-dated, isolated settings on restart', async () => {
  const { buildDailySummary } = await helpers;
  assert.equal(getGeneralSchedule(a).versions[0].settings.sundayEnabled, false);
  let group = saveScheduleGroup(a, null, { name: 'Domingos', effectiveFrom: '2026-11-01', settings, employeeIds: ['1'] }, 'admin');
  assert.equal(group.versions[0].settings.sundayEnabled, false);
  group = saveScheduleGroup(a, group.id, { name: 'Domingos', revision: group.revision, effectiveFrom: '2026-11-08', settings: enabled, employeeIds: ['1'] }, 'admin');
  const rows = buildDailySummary([...events('2026-11-01', ['07:00', '12:50']), ...events('2026-11-08', ['07:00', '12:50'])], getEmployees(a),
    { ...getDeviceById(a), generalReportSchedule: getGeneralSchedule(a), reportScheduleGroups: listScheduleGroups(a) });
  assert.equal(rows[0].status, 'Sin horario');
  assert.equal(rows[1].shiftEnd, '12:00');
  assert.equal(rows[1].overtimeMinutes, 60);
  assert.equal(listScheduleGroups(b).length, 0);
  const restart = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./services/reportSchedules").listScheduleGroups('+JSON.stringify(a)+')))'], { cwd: __dirname, env: process.env, encoding: 'utf8' }));
  assert.deepEqual(restart, listScheduleGroups(a));
  const config = db.prepare('SELECT config FROM devices WHERE id=?').get(a).config;
  assert.throws(() => updateDevice(a, { sundayEnabled: true }), error => error.statusCode === 400);
  assert.equal(db.prepare('SELECT config FROM devices WHERE id=?').get(a).config, config);
});

test('invalid Sunday input cannot partially write a schedule or its assignments', () => {
  const before = db.prepare('SELECT count(*) n FROM report_schedule_audit').get().n;
  for (const bad of [{ sundayEnabled: 'false' }, { sunShiftStart: '25:00' }, { sunShiftEnd: '07:00' }]) {
    assert.throws(() => saveScheduleGroup(a, null, { name: 'Invalid Sunday', effectiveFrom: '2026-11-08', settings: { ...enabled, ...bad }, employeeIds: ['2'] }, 'admin'));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM report_schedule_audit').get().n, before);
  assert.deepEqual(getEmployees(a).find(value => value.employeeId === '2').scheduleAssignments, []);
});

test('clients without Sunday fields preserve the configured Sunday when editing existing versions', () => {
  let general = getGeneralSchedule(b);
  general = saveGeneralSchedule(b, { revision: general.revision, effectiveFrom: '2026-11-01', settings: enabled }, 'admin');
  general = saveGeneralSchedule(b, { revision: general.revision, effectiveFrom: '2026-11-08', settings: { ...settings, graceMinutes: 20 } }, 'admin');
  assert.equal(general.versions.at(-1).settings.sundayEnabled, true);
  assert.equal(general.versions.at(-1).settings.sunShiftStart, '07:00');
  assert.equal(general.versions.at(-1).settings.sunShiftEnd, '12:00');
});

test('a legacy group does not inherit new Sunday fields from the general schedule', async () => {
  const { buildDailySummary } = await helpers;
  const schedule = { ...enabled, sundayEnabled: false, reportScheduleGroups: [{ id: 'legacy', name: 'Legacy', versions: [{ effectiveFrom: '2026-11-01', settings }] }] };
  const [row] = buildDailySummary(events('2026-11-08', ['08:00', '17:00']), [{ employeeId: '1', scheduleAssignments: [{ effectiveFrom: '2026-11-01', groupId: 'legacy' }] }], schedule);
  assert.equal(row.isScheduled, true);
  assert.equal(row.shiftStart, '08:00');
  assert.equal(row.shiftEnd, '17:00');
});

test('Sunday schedule API respects device permissions and never connects to a biometric clock', async () => {
  let connections = 0;
  mock.method(require('zklib-js').prototype, 'createSocket', async () => { connections++; throw new Error('No hardware'); });
  const { authenticate, createUser } = require('./services/auth');
  createUser({ username: 'sunday-operator', password: process.env.INITIAL_ADMIN_PASSWORD, assignedDevices: [a] });
  const token = authenticate('sunday-operator', process.env.INITIAL_ADMIN_PASSWORD).token;
  const server = require('./index').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (id, auth = token) => {
    const response = await fetch(`${base}/api/device/report-schedules?deviceId=${id}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth ? `Bearer ${auth}` : '' },
      body: JSON.stringify({ name: 'API Sunday', settings: enabled, effectiveFrom: '2026-11-08', employeeIds: ['2'] }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await request(a, '')).status, 401);
    assert.equal((await request(b)).status, 404);
    const saved = await request(a);
    assert.equal(saved.status, 201);
    assert.equal(saved.data.group.versions[0].settings.sunShiftEnd, '12:00');
    assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
