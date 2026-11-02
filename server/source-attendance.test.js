const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const settings = { shiftStart: '08:30', shiftEnd: '18:00', satShiftStart: '08:30', satShiftEnd: '15:00', graceMinutes: 15 };
async function calculate(times, date = '2026-10-30') {
  const { buildDailySummary } = await modulePromise;
  return buildDailySummary(times.map(time => ({ employeeId: '1', timestamp: `${date}T${time}:00` })), [], settings)[0];
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
  const row = await calculate(['08:45', '18:10']);
  assert.equal(row.isLate, false);
  assert.equal(row.overtimeMinutes, 10);
});
test('Saturday end time is respected', async () => {
  assert.equal((await calculate(['08:30', '15:10'], '2026-10-31')).overtimeMinutes, 10);
});
