const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.resolve(__dirname, '../dist/assets/index-DyCXu5bn.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(code.slice(code.indexOf('const ite=60*1e3;'), code.indexOf('const B7=z7()')), context);
const settings = { shiftStart: '08:30', shiftEnd: '18:00', satShiftStart: '08:30', satShiftEnd: '15:00', graceMinutes: 15 };
function calculate(times, date = '2026-10-30') {
  return context.ate({ dateKey: date, punches: times.map(time => new Date(`${date}T${time}:00`)) }, settings);
}
test('early departure with timely arrival is not a late arrival', () => {
  const day = calculate(['08:40', '17:00']);
  assert.equal(day.isLate, false);
  assert.equal(day.isEarlyLeave, true);
  assert.equal(day.status, 'S. Temprana');
});
test('a single afternoon punch is incomplete, not a late arrival', () => {
  const day = calculate(['17:00']);
  assert.equal(day.isIncomplete, true);
  assert.equal(day.isLate, false);
  assert.equal(day.isEarlyLeave, false);
  assert.equal(context.u8([day])[0].lateCount, 0);
});
test('late arrival and early departure retain both incidents', () => {
  const day = calculate(['08:46', '17:00']);
  assert.equal(day.isLate, true);
  assert.equal(day.isEarlyLeave, true);
  assert.equal(day.status, 'Retardo + S.Temp.');
});
test('entry tolerance and weekday/Saturday overtime remain unchanged', () => {
  assert.equal(calculate(['08:45', '18:10']).isLate, false);
  assert.equal(calculate(['08:45', '18:10']).overtimeMinutes, 10);
  assert.equal(calculate(['08:45', '15:10'], '2026-10-31').overtimeMinutes, 10);
});
test('distribution assigns one category per day', () => {
  const start = code.indexOf('let Z=0,we=0,Qe=0,et=0,both=0;');
  const end = code.indexOf('.filter(_r=>_r.value>0)', start);
  assert.ok(start >= 0 && end > start);
  const fn = vm.runInContext('(Gr)=>{' + code.slice(start, end) + '.filter(_r=>_r.value>0)}', context);
  const values = fn([calculate(['08:40','17:00']), calculate(['08:46','17:00']), calculate(['17:00'])]);
  assert.equal(values.reduce((n, row) => n + row.value, 0), 3);
  assert.equal(values.find(row => row.name === 'Retardo'), undefined);
});
