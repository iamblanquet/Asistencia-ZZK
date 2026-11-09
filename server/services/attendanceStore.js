const { db } = require('./sqlite');
const { getEmployees } = require('./db');
const { getStoredEvents } = require('./eventStore');
const { listScheduleGroups, getGeneralSchedule } = require('./reportSchedules');

function getSavedAttendance(device, filters = {}) {
  for (const value of [filters.from, filters.to]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      const error = new Error('Fecha de consulta no valida.');
      error.statusCode = 400;
      error.publicMessage = error.message;
      throw error;
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    const error = new Error('El inicio del periodo no puede ser posterior al fin.');
    error.statusCode = 400;
    error.publicMessage = error.message;
    throw error;
  }
  const status = db.prepare('SELECT * FROM device_sync_status WHERE device_id=?').get(device.id);
  const employees = getEmployees(device.id).filter(employee =>
    device.currentUsersOnly !== true || employee.devicePresent === true);
  const currentEmployeeIds = device.currentUsersOnly === true
    ? new Set(employees.map(employee => employee.employeeId)) : null;
  const seen = new Set();
  const padded = { ...filters };
  if (filters.includeScheduleEdges) {
    const shiftDate = (value, days) => {
      const date = new Date(`${value}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + days);
      return date.toISOString().slice(0, 10);
    };
    if (filters.from) padded.from = shiftDate(filters.from, -1);
    if (filters.to) padded.to = shiftDate(filters.to, 1);
  }
  const saved = getStoredEvents(device.id, padded).filter(event => {
    if (currentEmployeeIds && !currentEmployeeIds.has(event.employeeId)) return false;
    // Keep the same minute-level duplicate handling as the previous live query.
    const key = `${event.employeeId}:${event.localDate}:${event.localTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(event => ({ ...event, id: `${device.id}:${event.employeeId}:${event.timestamp}` }));
  const inRange = event => (!filters.from || event.localDate >= filters.from) && (!filters.to || event.localDate <= filters.to);
  const events = saved.filter(inRange);
  return {
    device, employees, events, reportScheduleGroups: listScheduleGroups(device.id),
    generalReportSchedule: getGeneralSchedule(device.id),
    boundaryEvents: filters.includeScheduleEdges ? saved.filter(event => !inRange(event)) : [],
    deviceInfo: status?.device_info ? JSON.parse(status.device_info) : null,
    fetchedAt: status?.last_success || null,
    sync: { lastSuccessAt: status?.last_success || null, lastAttemptAt: status?.last_attempt || null, lastError: status?.last_error || null },
    source: 'database',
  };
}

function recordSyncAttempt(deviceId) {
  db.prepare(`INSERT INTO device_sync_status(device_id,last_attempt) VALUES (?,?)
    ON CONFLICT(device_id) DO UPDATE SET last_attempt=excluded.last_attempt,last_error=NULL`).run(deviceId, new Date().toISOString());
}
function recordSyncSuccess(deviceId, deviceInfo) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO device_sync_status(device_id,last_success,last_attempt,device_info) VALUES (?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET last_success=excluded.last_success,last_error=NULL,device_info=excluded.device_info`)
    .run(deviceId, now, now, deviceInfo ? JSON.stringify(deviceInfo) : null);
}
function recordSyncFailure(deviceId, error) {
  db.prepare('UPDATE device_sync_status SET last_error=? WHERE device_id=?').run(error.publicMessage || error.message || error.err?.message || 'No se pudo sincronizar.', deviceId);
}
module.exports = { getSavedAttendance, recordSyncAttempt, recordSyncSuccess, recordSyncFailure };
