import { dateTimeLabel, durationLabel, timeLabel } from './attendance';

function cell(value) {
  let text = value == null ? '' : String(value).replace(/\0/g, '');
  // Quoting alone does not stop Excel from interpreting user-controlled formulas.
  if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function encodeCsv(matrix) {
  return '\uFEFF' + matrix.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function exportFilePart(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'sin-dato';
}

const deviceHeaders = ['ID biometrico', 'Biometrico', 'IP', 'Desde', 'Hasta'];
const deviceValues = (device, range = {}) => [String(device.id || ''), device.name || '', device.ip || '', range.from || '', range.to || ''];
const iso = value => value ? new Date(value).toISOString() : '';

export function attendanceCsv(rows, device, range) {
  return encodeCsv([[...deviceHeaders, 'Fecha', 'ID colaborador', 'Colaborador', 'Horario', 'Entrada programada', 'Salida programada',
    'Tolerancia entrada (min)', 'Entrada', 'Salida', 'Entrada ISO UTC', 'Salida ISO UTC', 'Trabajadas', 'Trabajadas (min)',
    'Programadas (min)', 'Retardo', 'Retardo (min)', 'Salida temprana', 'Salida temprana (min)', 'Horas extra', 'Horas extra (min)',
    'Estado', 'Checadas totales', 'Checadas efectivas', 'Intentos repetidos', 'Marcaciones', 'Jornada programada'], ...rows.map(row => [
    ...deviceValues(device, range), row.dateKey, String(row.employeeId), row.employeeName, row.scheduleName || 'Horario general',
    row.shiftStart, row.shiftEnd, row.graceMinutes, row.firstPunch ? timeLabel(row.firstPunch) : '', row.lastPunch ? timeLabel(row.lastPunch) : '',
    iso(row.firstPunch), iso(row.lastPunch), durationLabel(row.workedMinutes), row.workedMinutes, row.scheduledMinutes,
    row.isLate ? 'Si' : 'No', row.isLate ? row.lateMinutes : 0, row.isEarlyLeave ? 'Si' : 'No', row.earlyLeaveMinutes,
    durationLabel(row.overtimeMinutes), row.overtimeMinutes, row.status, row.punchCount, row.effectivePunchCount, row.duplicatePunchCount,
    (row.punches || []).map(dateTimeLabel).join(' | '),
    row.isScheduled === false ? 'No' : 'Si',
  ])]);
}

export function totalsCsv(totals, device, range) {
  return encodeCsv([[...deviceHeaders, 'ID colaborador', 'Colaborador', 'Dias registrados', 'Trabajadas', 'Trabajadas (min)',
    'Retardos', 'Retardo (min)', 'Salidas tempranas', 'Salida temprana (min)', 'Horas extra', 'Horas extra (min)', 'Dias incompletos'],
  ...totals.map(row => [...deviceValues(device, range), String(row.employeeId), row.employeeName, row.days,
    durationLabel(row.workedMinutes), row.workedMinutes, row.lateCount, row.lateMinutes, row.earlyLeaveCount, row.earlyLeaveMinutes,
    durationLabel(row.overtimeMinutes), row.overtimeMinutes, row.incompleteDays])]);
}

export function employeesCsv(employees, device, date, query = '') {
  const search = query.trim().toLocaleLowerCase('es');
  const active = employees.filter(employee => employee.devicePresent !== false
    && (!search || `${employee.employeeId} ${employee.name}`.toLocaleLowerCase('es').includes(search)));
  return encodeCsv([['ID biometrico', 'Biometrico', 'IP', 'Fecha de exportacion', 'ID colaborador', 'Nombre completo',
    'Rol', 'No. tarjeta', 'UID', 'Horario'], ...active.map(employee => [String(device.id || ''), device.name || '', device.ip || '', date,
    String(employee.employeeId), employee.name, employee.role === 14 ? 'Administrador' : 'Usuario normal', String(employee.cardNo ?? ''),
    String(employee.uid ?? ''), employee.scheduleName || 'Horario general'])]);
}

export function eventsCsv(events, device, range) {
  return encodeCsv([[...deviceHeaders, 'Fecha', 'Hora', 'Fecha y hora ISO UTC', 'ID colaborador', 'Colaborador', 'Evento',
    'Origen', 'ID usuario del equipo', 'UID'], ...events.map(event => [...deviceValues(device, range), event.localDate || '',
    event.localTime || timeLabel(event.timestamp), iso(event.timestamp), String(event.employeeId), event.employeeName,
    event.eventType || 'Marcacion', event.source || '', String(event.deviceUserId ?? ''), String(event.uid ?? '')])]);
}

export function employeeCsvFiles(rows, device, range) {
  const groups = new Map();
  for (const row of rows) {
    const id = String(row.employeeId);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b, 'es', { numeric: true })).map(([employeeId, days], index) => ({
    employeeId,
    filename: `${String(index + 1).padStart(3, '0')}-asistencias-${exportFilePart(employeeId)}-${exportFilePart(days[0].employeeName)}.csv`,
    content: attendanceCsv(days, device, range),
  }));
}
