const crypto = require('node:crypto');
const { db, employee } = require('./sqlite');
const defaults = { model: 'WL20/EWL20', protocol: 'zk', port: 4370, timeout: 15000, inport: 4000, shiftStart: '08:00', shiftEnd: '17:00', satShiftStart: '08:00', satShiftEnd: '13:00', graceMinutes: 10 };
function normalizeDevice(value) { return { ...defaults, ...value, id: String(value.id) }; }
function getDevices() {
  return db.prepare('SELECT config FROM devices WHERE deleted_at IS NULL ORDER BY rowid').all().map(row => normalizeDevice(JSON.parse(row.config)));
}
function getDeviceById(id) { return getDevices().find(d => d.id === String(id)) || null; }
function addDevice(value) {
  const device = normalizeDevice({ ...value, id: `dev-${crypto.randomUUID()}` });
  db.prepare('INSERT INTO devices(id,config) VALUES (?,?)').run(device.id, JSON.stringify(device));
  return device;
}
function updateDevice(id, value) {
  const old = getDeviceById(id);
  if (!old) return null;
  const defined = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  const device = normalizeDevice({ ...old, ...defined, id: old.id });
  db.prepare('UPDATE devices SET config=? WHERE id=? AND deleted_at IS NULL').run(JSON.stringify(device), old.id);
  return device;
}
function deleteDevice(id) {
  db.prepare('UPDATE devices SET deleted_at=? WHERE id=?').run(new Date().toISOString(), String(id));
  return true;
}
function getEmployeeOverrides(deviceId) {
  if (!deviceId) throw new Error('Biometrico requerido.');
  return Object.fromEntries(db.prepare('SELECT employee_id,override_name FROM employees WHERE device_id=? AND override_name IS NOT NULL').all(String(deviceId)).map(row => [row.employee_id, row.override_name]));
}
function updateEmployeeName(deviceId, employeeId, name) {
  if (!getDeviceById(deviceId)) throw new Error('Biometrico no encontrado.');
  const updated = db.prepare('UPDATE employees SET override_name=? WHERE device_id=? AND employee_id=?').run(String(name).trim(), String(deviceId), String(employeeId));
  if (!updated.changes) throw new Error('Empleado no encontrado en este biometrico.');
  return { deviceId, employeeId, name };
}
function saveEmployees(deviceId, values) {
  // Callers provide a complete verified roster; missing employees remain historical.
  db.transaction(() => {
    const checkedAt = new Date().toISOString();
    db.prepare(`INSERT INTO employee_device_status(device_id,employee_id,present,checked_at)
      SELECT device_id,employee_id,0,? FROM employees WHERE device_id=?
      ON CONFLICT(device_id,employee_id) DO UPDATE SET present=0,checked_at=excluded.checked_at`).run(checkedAt, deviceId);
    const present = db.prepare(`INSERT INTO employee_device_status(device_id,employee_id,present,checked_at) VALUES (?,?,1,?)
      ON CONFLICT(device_id,employee_id) DO UPDATE SET present=1,checked_at=excluded.checked_at`);
    for (const value of values) {
      employee(deviceId, value);
      present.run(deviceId, String(value.employeeId), checkedAt);
    }
  })();
}
function getEmployees(deviceId) {
  if (!deviceId) throw new Error('Biometrico requerido.');
  return db.prepare(`SELECT e.employee_id AS employeeId,COALESCE(e.override_name,e.name) AS name,
    e.uid,e.role,e.card_no AS cardNo,s.present AS devicePresent
    FROM employees e LEFT JOIN employee_device_status s ON s.device_id=e.device_id AND s.employee_id=e.employee_id
    WHERE e.device_id=? ORDER BY e.employee_id`).all(String(deviceId))
    .map(value => ({ ...value, devicePresent: value.devicePresent === null ? null : Boolean(value.devicePresent) }));
}
module.exports = { getDevices, getDeviceById, addDevice, updateDevice, deleteDevice, getEmployeeOverrides, updateEmployeeName, saveEmployees, getEmployees };
