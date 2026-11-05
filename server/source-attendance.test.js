const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const settings = { shiftStart: '08:30', shiftEnd: '18:00', satShiftStart: '08:30', satShiftEnd: '15:00', graceMinutes: 15 };
const groupSettings = { shiftStart: '07:00', shiftEnd: '16:00', satShiftStart: '07:00', satShiftEnd: '12:00', graceMinutes: 10 };
const groupedSettings = { ...settings, reportScheduleGroups: [{ id: 'early', name: 'Temprano', versions: [
  { effectiveFrom: '2026-11-04', settings: groupSettings },
  { effectiveFrom: '2026-11-10', settings: { ...groupSettings, shiftStart: '06:00', shiftEnd: '15:00' } },
] }] };
const groupEmployees = ['1', '2'].map(employeeId => ({ employeeId, name: employeeId, scheduleAssignments: [
  { effectiveFrom: '2026-11-04', groupId: 'early' }, { effectiveFrom: '2026-11-12', groupId: null },
] }));

test('group schedules apply to multiple employees with independent entry grace, exit and daily overtime', async () => {
  const { buildDailySummary } = await modulePromise;
  const events = [['1', '07:10'], ['1', '16:50'], ['2', '07:11'], ['2', '15:59'], ['3', '08:40'], ['3', '18:00']]
    .map(([employeeId, time]) => ({ employeeId, timestamp: `2026-11-04T${time}:00` }));
  const rows = buildDailySummary(events, groupEmployees, groupedSettings);
  assert.equal(rows[0].scheduleName, 'Temprano');
  assert.equal(rows[0].isLate, false);
  assert.equal(rows[0].overtimeMinutes, 60);
  assert.equal(rows[1].isLate, true);
  assert.equal(rows[1].lateMinutes, 11);
  assert.equal(rows[1].earlyLeaveMinutes, 1);
  assert.equal(rows[2].scheduleName, 'Horario general');
  assert.equal(rows[2].isLate, false);
});

test('effective dates select historic versions and return to the general schedule without rewriting past days', async () => {
  const { resolveReportSchedule } = await modulePromise;
  const emp = groupEmployees[0];
  for (const [date, start] of [['2026-11-03', '08:30'], ['2026-11-04', '07:00'], ['2026-11-09', '07:00'], ['2026-11-10', '06:00'], ['2026-11-12', '08:30']]) {
    assert.equal(resolveReportSchedule(emp, groupedSettings, date).shiftStart, start, date);
  }
});

test('general schedule history protects old calculations even when the current flat settings change', async () => {
  const { buildDailySummary, resolveReportSchedule } = await modulePromise;
  const history = { ...settings, shiftStart: '06:00', shiftEnd: '15:00', graceMinutes: 0,
    generalReportSchedule: { revision: 3, versions: [
      { effectiveFrom: '0001-01-01', settings },
      { effectiveFrom: '2026-11-04', settings: { ...settings, shiftStart: '07:00', shiftEnd: '16:00', graceMinutes: 10 } },
      { effectiveFrom: '2026-11-10', settings: { ...settings, shiftStart: '06:00', shiftEnd: '15:00', graceMinutes: 0 } },
    ] } };
  const events = [['2026-11-03', '08:40'], ['2026-11-03', '18:50'], ['2026-11-04', '07:10'], ['2026-11-04', '16:50'], ['2026-11-10', '06:01'], ['2026-11-10', '15:49']]
    .map(([date, time]) => ({ employeeId: '1', timestamp: `${date}T${time}:00` }));
  const rows = buildDailySummary(events, [], history);
  assert.deepEqual(rows.map(row => row.shiftStart), ['08:30', '07:00', '06:00']);
  assert.deepEqual(rows.map(row => row.isLate), [false, false, true]);
  assert.deepEqual(rows.map(row => row.overtimeMinutes), [60, 60, 0]);
  assert.deepEqual(rows.map(row => row.isEarlyLeave), [false, false, false]);
  const employee = { scheduleAssignments: [{ effectiveFrom: '2026-11-04', groupId: 'early' }, { effectiveFrom: '2026-11-12', groupId: null }] };
  const combined = { ...history, reportScheduleGroups: groupedSettings.reportScheduleGroups };
  assert.equal(resolveReportSchedule(employee, combined, '2026-11-11').shiftEnd, '15:00');
  assert.equal(resolveReportSchedule(employee, combined, '2026-11-12').graceMinutes, 0);
  assert.equal(resolveReportSchedule(employee, combined, '2026-11-03').shiftEnd, '18:00');
});

test('night shift departure uses the previous general version when the next day changes to a daytime shift', async () => {
  const { buildDailySummary } = await modulePromise;
  const night = { ...settings, generalReportSchedule: { versions: [
    { effectiveFrom: '0001-01-01', settings: { ...settings, shiftStart: '22:00', shiftEnd: '06:00' } },
    { effectiveFrom: '2026-11-04', settings },
  ] } };
  const rows = buildDailySummary(['2026-11-03T22:00:00', '2026-11-04T06:50:00'].map(timestamp => ({ employeeId: '1', timestamp })), [], night);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dateKey, '2026-11-03');
  assert.equal(rows[0].shiftEnd, '06:00');
  assert.equal(rows[0].overtimeMinutes, 60);
});

test('group Saturday calculations use the group Saturday exit and tolerance', async () => {
  const { buildDailySummary } = await modulePromise;
  const events = ['07:10', '12:50'].map(time => ({ employeeId: '1', timestamp: `2026-11-07T${time}:00` }));
  const row = buildDailySummary(events, groupEmployees, groupedSettings)[0];
  assert.equal(row.shiftEnd, '12:00');
  assert.equal(row.scheduledMinutes, 300);
  assert.equal(row.isLate, false);
  assert.equal(row.overtimeMinutes, 60);
});

test('period late minutes exclude entries within each group tolerance', async () => {
  const { buildDailySummary, buildEmployeeTotals } = await modulePromise;
  const events = [['1', '07:10'], ['1', '16:00'], ['2', '07:11'], ['2', '16:00']]
    .map(([employeeId, time]) => ({ employeeId, timestamp: `2026-11-04T${time}:00` }));
  const totals = buildEmployeeTotals(buildDailySummary(events, groupEmployees, groupedSettings));
  assert.equal(totals[0].lateMinutes, 0);
  assert.equal(totals[1].lateMinutes, 11);
});

test('night groups keep overtime on the prior workday across a Saturday schedule change', async () => {
  const { buildDailySummary } = await modulePromise;
  const night = { ...groupedSettings, reportScheduleGroups: [{ id: 'early', name: 'Noche', versions: [{ effectiveFrom: '2026-11-04',
    settings: { ...groupSettings, shiftStart: '22:00', shiftEnd: '06:00', satShiftStart: '08:00' } }] }] };
  const events = ['2026-11-06T21:58:00', '2026-11-07T06:50:00'].map(timestamp => ({ employeeId: '1', timestamp }));
  const rows = buildDailySummary(events, groupEmployees, night);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dateKey, '2026-11-06');
  assert.equal(rows[0].overtimeMinutes, 60);
});

test('event log classifies exits with each group and does not turn duplicate entries into departures', async () => {
  const { enrichAttendanceEvents } = await modulePromise;
  const events = [['1', '07:00'], ['1', '16:00'], ['3', '07:00'], ['3', '16:00'], ['2', '07:00'], ['2', '07:03']]
    .map(([employeeId, time], id) => ({ id, employeeId, timestamp: `2026-11-04T${time}:00` }));
  const enriched = enrichAttendanceEvents(events, groupEmployees, groupedSettings);
  assert.equal(enriched[1].eventType, 'Salida');
  assert.equal(enriched[3].eventType, 'Salida Temprana');
  assert.equal(enriched[5].eventType, 'Marcación');
});
async function calculate(times, date = '2026-10-30') {
  const { buildDailySummary } = await modulePromise;
  return buildDailySummary(times.map(time => ({ employeeId: '1', timestamp: `${date}T${time.length === 5 ? time + ':00' : time}` })), [], settings)[0];
}
test('early leave alone is not late', async () => {
  const row = await calculate(['08:40', '17:00']);
  assert.equal(row.isEarlyLeave, true);
  assert.equal(row.isLate, false);
});
test('single punch is incomplete, not late', async () => {
  const row = await calculate(['17:00']);
  assert.equal(row.isIncomplete, true);
  assert.equal(row.isLate, false);
});
test('both incidents remain separate flags', async () => {
  const row = await calculate(['08:46', '17:00']);
  assert.equal(row.isEarlyLeave, true);
  assert.equal(row.isLate, true);
});
test('entry grace does not reduce overtime', async () => {
  const row = await calculate(['08:45', '19:10']);
  assert.equal(row.isLate, false);
  assert.equal(row.overtimeMinutes, 60);
});
test('Saturday end time is respected', async () => {
  assert.equal((await calculate(['08:30', '16:10'], '2026-10-31')).overtimeMinutes, 60);
});

test('daily overtime recognizes hours at exact 50-minute thresholds', async () => {
  for (const [exit, minutes] of [['17:59', 0], ['18:00', 0], ['18:20', 0], ['18:49', 0], ['18:49:59', 0], ['18:50', 60], ['18:59:59', 60], ['19:00', 60], ['19:20', 60], ['19:49', 60], ['19:49:59', 60], ['19:50', 120], ['19:59:59', 120], ['20:00', 120], ['20:49:59', 120], ['20:50', 180]]) {
    assert.equal((await calculate(['08:30', exit])).overtimeMinutes, minutes, exit);
  }
});

test('partial overtime cannot accumulate across days or employees', async () => {
  const { buildDailySummary, buildEmployeeTotals } = await modulePromise;
  const punches = [
    ['1', '2026-11-02', '08:30'], ['1', '2026-11-02', '18:20'],
    ['1', '2026-11-03', '08:30'], ['1', '2026-11-03', '18:40'],
    ['2', '2026-11-02', '08:30'], ['2', '2026-11-02', '18:40'],
  ].map(([employeeId, date, time]) => ({ employeeId, timestamp: `${date}T${time}:00` }));
  const totals = buildEmployeeTotals(buildDailySummary(punches, [], settings));
  assert.equal(totals.reduce((sum, row) => sum + row.overtimeMinutes, 0), 0);
});

test('period totals sum independently recognized daily hours', async () => {
  const { buildEmployeeTotals } = await modulePromise;
  const days = [await calculate(['08:30', '19:20']), await calculate(['08:30', '19:50'], '2026-11-02')];
  assert.equal(buildEmployeeTotals(days)[0].overtimeMinutes, 180);
});

test('Saturday uses the same 50-minute threshold after its scheduled exit', async () => {
  assert.equal((await calculate(['08:30', '15:49:59'], '2026-10-31')).overtimeMinutes, 0);
  assert.equal((await calculate(['08:30', '15:50'], '2026-10-31')).overtimeMinutes, 60);
  assert.equal((await calculate(['08:30', '16:50'], '2026-10-31')).overtimeMinutes, 120);
});

test('single late punch never produces overtime', async () => {
  assert.equal((await calculate(['20:00'])).overtimeMinutes, 0);
});

test('two entry attempts within five minutes remain an incomplete day', async () => {
  for (const times of [['07:55', '08:00'], ['08:00:01', '08:00:59'], ['08:00', '08:00']]) {
    const row = await calculate(times);
    assert.equal(row.status, 'Incompleto');
    assert.equal(row.lastPunch, null);
    assert.equal(row.workedMinutes, 0);
    assert.equal(row.isLate, false);
    assert.equal(row.isEarlyLeave, false);
    assert.equal(row.overtimeMinutes, 0);
    assert.equal(row.punchCount, 2);
    assert.equal(row.effectivePunchCount, 1);
    assert.equal(row.duplicatePunchCount, 1);
  }
});

test('a later departure completes the day without moving the first entry', async () => {
  const row = await calculate(['18:00', '08:00', '07:55']);
  assert.equal(row.firstPunch.getHours(), 7);
  assert.equal(row.firstPunch.getMinutes(), 55);
  assert.equal(row.lastPunch.getHours(), 18);
  assert.equal(row.status, 'A tiempo');
  assert.equal(row.workedMinutes, 605);
  assert.equal(row.effectivePunchCount, 2);
  assert.equal(row.punchCount, 3);
});

test('repeated departure attempts retain the final departure and overtime threshold', async () => {
  const row = await calculate(['08:30', '08:32', '18:48', '18:50']);
  assert.equal(row.effectivePunchCount, 2);
  assert.equal(row.lastPunch.getMinutes(), 50);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.workedMinutes, 620);
});

test('two late entry attempts do not create an early departure or overtime', async () => {
  const row = await calculate(['19:00', '19:04']);
  assert.equal(row.isIncomplete, true);
  assert.equal(row.isEarlyLeave, false);
  assert.equal(row.isLate, false);
  assert.equal(row.overtimeMinutes, 0);
});

test('attempt window uses exact seconds and does not chain beyond five minutes', async () => {
  assert.equal((await calculate(['08:00:00', '08:05:00'])).effectivePunchCount, 1);
  assert.equal((await calculate(['08:00:00', '08:05:01'])).effectivePunchCount, 2);
  assert.equal((await calculate(['08:00', '08:04', '08:08', '08:12'])).effectivePunchCount, 2);
});

test('grouping does not cross employees or workdays and leaves original events untouched', async () => {
  const { buildDailySummary, buildEmployeeTotals } = await modulePromise;
  const events = [
    { employeeId: '1', timestamp: '2026-11-02T08:00:00' },
    { employeeId: '1', timestamp: '2026-11-02T08:03:00' },
    { employeeId: '2', timestamp: '2026-11-02T08:02:00' },
    { employeeId: '1', timestamp: '2026-11-03T08:01:00' },
  ];
  const original = JSON.stringify(events);
  const rows = buildDailySummary(events, [], settings);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.isIncomplete));
  assert.equal(buildEmployeeTotals(rows).reduce((sum, row) => sum + row.earlyLeaveCount, 0), 0);
  assert.equal(JSON.stringify(events), original);
});

test('duplicate attempts in a night shift share the same workday', async () => {
  const { buildDailySummary } = await modulePromise;
  const events = ['2026-11-02T22:00:00', '2026-11-02T22:04:00', '2026-11-03T05:58:00', '2026-11-03T06:00:00']
    .map(timestamp => ({ employeeId: '1', timestamp }));
  const [row] = buildDailySummary(events, [], { ...settings, shiftStart: '22:00', shiftEnd: '06:00' });
  assert.equal(row.dateKey, '2026-11-02');
  assert.equal(row.effectivePunchCount, 2);
  assert.equal(row.workedMinutes, 480);
  assert.equal(row.status, 'A tiempo');
});

test('table filters every state including combined incidents without changing dashboard rows', async () => {
  const { filterAndSortDailyRows } = await modulePromise;
  const statuses = ['A tiempo', 'Retardo', 'S. Temprana', 'Retardo + S.Temp.', 'Incompleto'];
  const rows = statuses.map((status, index) => ({ status, dateKey: '2026-11-03', employeeId: String(index + 1) }));
  const before = JSON.stringify(rows);
  for (const status of statuses) {
    assert.deepEqual(filterAndSortDailyRows(rows, status).map(row => row.status), [status]);
  }
  assert.equal(filterAndSortDailyRows(rows).length, rows.length);
  assert.deepEqual(filterAndSortDailyRows(rows, 'Otro estado'), []);
  assert.equal(JSON.stringify(rows), before);
});

test('table order is chronological in both directions with numeric employee IDs', async () => {
  const { filterAndSortDailyRows } = await modulePromise;
  const rows = [
    { dateKey: '2026-11-03', employeeId: '10', status: 'Retardo' },
    { dateKey: '2026-10-31', employeeId: '1', status: 'A tiempo' },
    { dateKey: '2026-11-03', employeeId: '2', status: 'Retardo' },
  ];
  assert.deepEqual(filterAndSortDailyRows(rows).map(row => row.employeeId), ['1', '2', '10']);
  assert.deepEqual(filterAndSortDailyRows(rows, 'all', true).map(row => row.employeeId), ['10', '2', '1']);
  assert.deepEqual(filterAndSortDailyRows(rows, 'Retardo', true).map(row => row.employeeId), ['10', '2']);
  assert.deepEqual(rows.map(row => row.employeeId), ['10', '1', '2']);
  assert.deepEqual(filterAndSortDailyRows([]), []);
});

test('event log shows newest dates and times first without changing events or their types', async () => {
  const { sortEventsNewestFirst } = await modulePromise;
  const events = [
    { id: 'old', timestamp: '2026-10-31T18:00:00-06:00', eventType: 'Salida' },
    { id: 'entry', timestamp: '2026-11-03T08:00:00-06:00', eventType: 'Entrada' },
    { id: 'exit', timestamp: '2026-11-03T17:00:00-06:00', eventType: 'Salida' },
    { id: 'yesterday', timestamp: '2026-11-02T18:00:00-06:00', eventType: 'Salida' },
  ];
  const before = JSON.stringify(events);
  const sorted = sortEventsNewestFirst(events);
  assert.deepEqual(sorted.map(event => event.id), ['exit', 'entry', 'yesterday', 'old']);
  assert.equal(sorted[1].eventType, 'Entrada');
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(sortEventsNewestFirst([]), []);
});
