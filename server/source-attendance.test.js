const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const settings = { shiftStart: '08:30', shiftEnd: '18:00', satShiftStart: '08:30', satShiftEnd: '15:00', graceMinutes: 15 };
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
