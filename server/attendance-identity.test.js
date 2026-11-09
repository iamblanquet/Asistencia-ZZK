const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEmployeeIndex, resolveAttendanceIdentity } = require('./services/attendanceIdentity');
const employees = [
  { employeeId: '2', uid: '37', name: 'ID 2' },
  { employeeId: '3', uid: '38', name: 'ID 3' },
  { employeeId: '52', uid: '2', name: 'ID 52' },
  { employeeId: '53', uid: '3', name: 'ID 53' },
];

test('explicit IDs never share the UID namespace regardless of roster ordering', () => {
  for (const roster of [employees, [...employees].reverse()]) {
    const index = buildEmployeeIndex(roster);
    for (const id of ['2', '3', '52', '53']) {
      const result = resolveAttendanceIdentity({ deviceUserId: id }, index);
      assert.equal(result.employeeId, id);
      assert.equal(result.employee.employeeId, id);
      assert.equal(result.identitySource, 'employee-id');
    }
  }
});

test('an explicit missing or retired ID is never reassigned to a matching UID', () => {
  const index = buildEmployeeIndex([{ employeeId: '611', uid: '6' }]);
  const result = resolveAttendanceIdentity({ deviceUserId: '6', userSn: '14' }, index);
  assert.equal(result.employeeId, '6');
  assert.equal(result.employee, undefined);
  assert.equal(result.uid, '14');
});

test('the wire UID is preserved and cannot override the explicit user ID', () => {
  const result = resolveAttendanceIdentity({ deviceUserId: '2', userSn: '99' }, buildEmployeeIndex(employees));
  assert.equal(result.employeeId, '2');
  assert.equal(result.uid, '99');
  assert.equal(resolveAttendanceIdentity({ deviceUserId: '002' }, buildEmployeeIndex(employees)).employeeId, '002');
});

test('UID-only events require an unambiguous current roster entry', () => {
  const index = buildEmployeeIndex(employees);
  assert.equal(resolveAttendanceIdentity({ uid: '2' }, index).employeeId, '52');
  assert.equal(resolveAttendanceIdentity({ userSn: '37' }, index).employeeId, '2');
  assert.throws(() => resolveAttendanceIdentity({ uid: '999' }, index), /UID/);
  assert.throws(() => resolveAttendanceIdentity({ uid: '2' }, buildEmployeeIndex([
    ...employees, { employeeId: '99', uid: '2' },
  ])), /UID/);
  assert.throws(() => resolveAttendanceIdentity({ uid: '2' }, buildEmployeeIndex([
    { employeeId: '52', uid: '2', devicePresent: false },
  ])), /UID/);
  assert.equal(resolveAttendanceIdentity({}, index), null);
});
