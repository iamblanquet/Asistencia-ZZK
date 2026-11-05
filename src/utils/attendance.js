const MINUTE = 60 * 1000;
const PUNCH_ATTEMPT_WINDOW = 5 * MINUTE;

export function todayInputValue() {
  return toInputDate(new Date());
}

export function addDays(dateKey, amount) {
  const date = parseInputDate(dateKey);
  date.setDate(date.getDate() + amount);
  return toInputDate(date);
}

export function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseInputDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

export function dateLabel(dateKey) {
  if (!dateKey) {
    return '';
  }
  const [year, month, day] = dateKey.split('-');
  return `${day}/${month}/${year}`;
}

export function dateTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${dateLabel(toInputDate(date))} ${timeLabel(date)}`;
}

export function timeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function durationLabel(minutes) {
  const rounded = Math.round(minutes || 0);
  const sign = rounded < 0 ? '-' : '';
  const absolute = Math.abs(rounded);
  const hours = Math.floor(absolute / 60);
  const mins = absolute % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export function decimalHours(minutes) {
  return Number(((minutes || 0) / 60).toFixed(2));
}

export function normalizeSundaySchedule(settings) {
  // Versions created before optional Sundays used the weekday hours on Sunday.
  const legacy = settings.sundayEnabled === undefined;
  return { ...settings, sundayEnabled: settings.sundayEnabled !== false,
    sunShiftStart: legacy ? settings.shiftStart : (settings.sunShiftStart || settings.shiftStart),
    sunShiftEnd: legacy ? settings.shiftEnd : (settings.sunShiftEnd || settings.shiftEnd) };
}

export function resolveGeneralReportSchedule(settings, dateKey) {
  const version = [...(settings.generalReportSchedule?.versions || [])].filter(value => value.effectiveFrom <= dateKey)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  return normalizeSundaySchedule({ ...settings, ...normalizeSundaySchedule(version?.settings || settings),
    scheduleName: 'Horario general', scheduleGroupId: null });
}

export function resolveReportSchedule(employee, settings, dateKey) {
  const general = resolveGeneralReportSchedule(settings, dateKey);
  const assignment = [...(employee?.scheduleAssignments || [])]
    .filter(value => value.effectiveFrom <= dateKey)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  const group = settings.reportScheduleGroups?.find(value => value.id === assignment?.groupId);
  const version = [...(group?.versions || [])].filter(value => value.effectiveFrom <= dateKey)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  return version ? { ...general, ...normalizeSundaySchedule(version.settings), scheduleName: group.name, scheduleGroupId: group.id } : general;
}

export function buildDailySummary(events, employees, settings) {
  const employeeLookup = new Map(employees.map((employee) => [String(employee.employeeId), employee]));
  const grouped = new Map();

  for (const event of events) {
    const timestamp = new Date(event.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      continue;
    }

    const employeeId = String(event.employeeId || event.deviceUserId || '');
    const employee = employeeLookup.get(employeeId);
    const dateKey = workDateForEvent(timestamp, settings, employee);
    const key = `${employeeId}::${dateKey}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        dateKey,
        employeeId,
        employeeName: employee?.name || event.employeeName || `Colaborador ${employeeId}`,
        punches: [],
      });
    }

    grouped.get(key).punches.push(timestamp);
  }

  return Array.from(grouped.values())
    .map((day) => calculateDay(day, resolveReportSchedule(employeeLookup.get(day.employeeId), settings, day.dateKey)))
    .sort((a, b) => {
      const byDate = a.dateKey.localeCompare(b.dateKey);
      if (byDate !== 0) {
        return byDate;
      }
      return a.employeeId.localeCompare(b.employeeId, 'es', { numeric: true });
    });
}

export function buildEmployeeTotals(rows) {
  const totals = new Map();

  for (const row of rows) {
    if (!totals.has(row.employeeId)) {
      totals.set(row.employeeId, {
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        days: 0,
        workedMinutes: 0,
        lateCount: 0,
        lateMinutes: 0,
        overtimeMinutes: 0,
        earlyLeaveCount: 0,
        earlyLeaveMinutes: 0,
        incompleteDays: 0,
      });
    }

    const total = totals.get(row.employeeId);
    total.days += 1;
    total.workedMinutes += row.workedMinutes;
    total.lateCount += row.isLate ? 1 : 0;
    total.lateMinutes += row.isLate ? row.lateMinutes : 0;
    total.overtimeMinutes += row.overtimeMinutes;
    total.earlyLeaveCount += row.isEarlyLeave ? 1 : 0;
    total.earlyLeaveMinutes += row.earlyLeaveMinutes;
    total.incompleteDays += row.isIncomplete ? 1 : 0;
  }

  return Array.from(totals.values()).sort((a, b) =>
    a.employeeId.localeCompare(b.employeeId, 'es', { numeric: true }),
  );
}

export function filterAndSortDailyRows(rows, status = 'all', descending = false) {
  const direction = descending ? -1 : 1;
  return rows.filter(row => status === 'all' || row.status === status).sort((a, b) => {
    const byDate = a.dateKey.localeCompare(b.dateKey);
    return direction * (byDate || a.employeeId.localeCompare(b.employeeId, 'es', { numeric: true }));
  });
}

export function sortEventsNewestFirst(events) {
  return [...events].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export function enrichAttendanceEvents(events, employees, settings) {
  const lookup = new Map(employees.map(employee => [String(employee.employeeId), employee]));
  const rows = new Map(buildDailySummary(events, employees, settings).map(row => [`${row.employeeId}::${row.dateKey}`, row]));
  return events.map(event => {
    const timestamp = new Date(event.timestamp);
    const employeeId = String(event.employeeId || event.deviceUserId || '');
    if (!Number.isFinite(timestamp.getTime())) return { ...event, eventType: 'Marcacion' };
    const dateKey = workDateForEvent(timestamp, settings, lookup.get(employeeId));
    const row = rows.get(`${employeeId}::${dateKey}`);
    const eventType = +timestamp === +row?.firstPunch ? 'Entrada'
      : row?.lastPunch && +timestamp === +row.lastPunch ? (row.isEarlyLeave ? 'Salida Temprana' : 'Salida') : 'Marcación';
    return { ...event, eventType };
  });
}

function calculateDay(day, settings) {
  const punches = [...day.punches].sort((a, b) => a - b);
  const attempts = [];
  for (const punch of punches) {
    const previous = attempts[attempts.length - 1];
    // Anchor to the first mark so repeated attempts cannot extend a group indefinitely.
    if (previous && punch - previous.first <= PUNCH_ATTEMPT_WINDOW) {
      previous.last = punch;
    } else {
      attempts.push({ first: punch, last: punch });
    }
  }
  const hasPair = attempts.length > 1;
  const firstPunch = attempts[0]?.first || null;
  const lastPunch = hasPair ? attempts[attempts.length - 1].last : null;
  
  const { shiftStart, shiftEnd, isScheduled } = shiftForDate(day.dateKey, settings);

  const scheduledStart = isScheduled ? parseDateTime(day.dateKey, shiftStart) : null;
  const scheduledEnd = isScheduled ? normalizeShiftEnd(day.dateKey, shiftStart, shiftEnd) : null;
  const graceMinutes = isScheduled ? Number(settings.graceMinutes || 0) : 0;

  const workedMinutes = hasPair
    ? Math.max(0, minutesBetween(firstPunch, lastPunch))
    : 0;
  const scheduledMinutes = isScheduled ? Math.max(0, minutesBetween(scheduledStart, scheduledEnd)) : 0;
  const lateMinutes = isScheduled && firstPunch ? Math.max(0, minutesBetween(scheduledStart, firstPunch)) : 0;
  const isLate = isScheduled && hasPair && lateMinutes > graceMinutes;
  // Recognize each extra hour at 50 minutes, separately for each employee/workday.
  const overtimeMinutes = isScheduled && hasPair
    ? Math.max(0, Math.floor((lastPunch - scheduledEnd + 10 * MINUTE) / (60 * MINUTE))) * 60
    : 0;
  const earlyLeaveMinutes = isScheduled && hasPair ? Math.max(0, minutesBetween(lastPunch, scheduledEnd)) : 0;
  const isEarlyLeave = earlyLeaveMinutes > 0;
  const isIncomplete = isScheduled && !hasPair;

  const status = !isScheduled ? 'Sin horario' : isIncomplete
    ? 'Incompleto'
    : (isLate && isEarlyLeave)
      ? 'Retardo + S.Temp.'
      : isLate
        ? 'Retardo'
        : isEarlyLeave
          ? 'S. Temprana'
          : 'A tiempo';

  return {
    ...day,
    punches,
    firstPunch,
    lastPunch,
    punchCount: punches.length,
    effectivePunchCount: attempts.length,
    duplicatePunchCount: punches.length - attempts.length,
    workedMinutes,
    scheduledMinutes,
    isScheduled,
    lateMinutes,
    graceMinutes,
    shiftStart,
    shiftEnd,
    scheduleName: settings.scheduleName,
    scheduleGroupId: settings.scheduleGroupId,
    reportSchedule: { shiftStart: settings.shiftStart, shiftEnd: settings.shiftEnd,
      satShiftStart: settings.satShiftStart, satShiftEnd: settings.satShiftEnd,
      sundayEnabled: settings.sundayEnabled, sunShiftStart: settings.sunShiftStart, sunShiftEnd: settings.sunShiftEnd,
      graceMinutes: Number(settings.graceMinutes || 0) },
    isLate,
    overtimeMinutes,
    earlyLeaveMinutes,
    isEarlyLeave,
    isIncomplete,
    status,
  };
}

function workDateForEvent(timestamp, defaults, employee) {
  const dateKey = toInputDate(timestamp);
  const settings = resolveReportSchedule(employee, defaults, dateKey);
  const current = shiftForDate(dateKey, settings);
  const previousDateKey = addDays(dateKey, -1);
  const previousSettings = resolveReportSchedule(employee, defaults, previousDateKey);
  const previous = shiftForDate(previousDateKey, previousSettings);
  if (!previous.isScheduled || previous.shiftEnd >= previous.shiftStart) return dateKey;

  // Keep the existing overnight boundary for Saturday exits on an unplanned Sunday.
  const start = parseDateTime(dateKey, current.shiftStart || settings.shiftStart);
  const previousEnd = normalizeShiftEnd(previousDateKey, previous.shiftStart, previous.shiftEnd);
  // Split the rest interval in half so overnight overtime remains on its workday.
  const cutoff = new Date((+previousEnd + Math.max(+previousEnd, +start)) / 2);
  if (timestamp < cutoff) return previousDateKey;

  return dateKey;
}

function shiftForDate(dateKey, settings) {
  const weekday = parseInputDate(dateKey).getDay();
  if (weekday === 0) return settings.sundayEnabled === false
    ? { shiftStart: null, shiftEnd: null, isScheduled: false }
    : { shiftStart: settings.sunShiftStart || settings.shiftStart, shiftEnd: settings.sunShiftEnd || settings.shiftEnd, isScheduled: true };
  return { shiftStart: weekday === 6 ? (settings.satShiftStart || '08:00') : settings.shiftStart,
    shiftEnd: weekday === 6 ? (settings.satShiftEnd || '13:00') : settings.shiftEnd, isScheduled: true };
}

function parseDateTime(dateKey, timeValue) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hours, minutes] = timeValue.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function normalizeShiftEnd(dateKey, shiftStart, shiftEnd) {
  const start = parseDateTime(dateKey, shiftStart);
  const end = parseDateTime(dateKey, shiftEnd);

  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }

  return end;
}

function minutesBetween(start, end) {
  return Math.round((end - start) / MINUTE);
}

