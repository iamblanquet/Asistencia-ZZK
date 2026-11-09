function clean(value) {
  return value == null ? '' : String(value).trim();
}

function buildEmployeeIndex(employees) {
  const byId = new Map();
  const byUid = new Map();
  for (const employee of employees) {
    const id = clean(employee.employeeId);
    if (id) byId.set(id, employee);
    const uid = clean(employee.uid);
    if (!uid || employee.devicePresent === false) continue;
    const previous = byUid.get(uid);
    byUid.set(uid, byUid.has(uid) && clean(previous?.employeeId) !== id ? null : employee);
  }
  return { byId, byUid };
}

function resolveAttendanceIdentity(record, index) {
  const id = clean(record.deviceUserId) || clean(record.userId) || clean(record.employeeId);
  const rawUid = clean(record.userSn) || clean(record.uid);
  if (id) {
    const employee = index.byId.get(id);
    return { employeeId: id, deviceUserId: id, employee,
      uid: rawUid || clean(employee?.uid), identitySource: 'employee-id' };
  }
  if (!rawUid) return null;
  const employee = index.byUid.get(rawUid);
  if (!employee) throw new Error('La checada solo contiene un UID sin un colaborador actual unico.');
  return { employeeId: clean(employee.employeeId), deviceUserId: clean(employee.employeeId),
    employee, uid: rawUid, identitySource: 'uid' };
}

module.exports = { buildEmployeeIndex, resolveAttendanceIdentity };
