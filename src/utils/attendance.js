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

export function buildDailySummary(events, employees, settings) {
  const employeeLookup = new Map(employees.map((employee) => [String(employee.employeeId), employee]));
  const grouped = new Map();

  for (const event of events) {
    const timestamp = new Date(event.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      continue;
    }

    const dateKey = workDateForEvent(timestamp, settings);
    const employeeId = String(event.employeeId || event.deviceUserId || '');
    const key = `${employeeId}::${dateKey}`;

    if (!grouped.has(key)) {
      const employee = employeeLookup.get(employeeId);
      grouped.set(key, {
        dateKey,
        employeeId,
        employeeName: employee?.name || event.employeeName || `Empleado ${employeeId}`,
        punches: [],
      });
    }

    grouped.get(key).punches.push(timestamp);
  }

  return Array.from(grouped.values())
    .map((day) => calculateDay(day, settings))
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
    total.lateMinutes += row.lateMinutes;
    total.overtimeMinutes += row.overtimeMinutes;
    total.earlyLeaveCount += row.isEarlyLeave ? 1 : 0;
    total.earlyLeaveMinutes += row.earlyLeaveMinutes;
    total.incompleteDays += row.isIncomplete ? 1 : 0;
  }

  return Array.from(totals.values()).sort((a, b) =>
    a.employeeId.localeCompare(b.employeeId, 'es', { numeric: true }),
  );
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
  
  const date = parseInputDate(day.dateKey);
  const isSaturday = date.getDay() === 6;
  const shiftStart = isSaturday ? (settings.satShiftStart || '08:00') : settings.shiftStart;
  const shiftEnd = isSaturday ? (settings.satShiftEnd || '13:00') : settings.shiftEnd;

  const scheduledStart = parseDateTime(day.dateKey, shiftStart);
  const scheduledEnd = normalizeShiftEnd(day.dateKey, shiftStart, shiftEnd);
  const graceMinutes = Number(settings.graceMinutes || 0);

  const workedMinutes = hasPair
    ? Math.max(0, minutesBetween(firstPunch, lastPunch))
    : 0;
  const scheduledMinutes = Math.max(0, minutesBetween(scheduledStart, scheduledEnd));
  const lateMinutes = firstPunch ? Math.max(0, minutesBetween(scheduledStart, firstPunch)) : 0;
  const isLate = hasPair && lateMinutes > graceMinutes;
  // Recognize each extra hour at 50 minutes, separately for each employee/workday.
  const overtimeMinutes = hasPair
    ? Math.max(0, Math.floor((lastPunch - scheduledEnd + 10 * MINUTE) / (60 * MINUTE))) * 60
    : 0;
  const earlyLeaveMinutes = hasPair ? Math.max(0, minutesBetween(lastPunch, scheduledEnd)) : 0;
  const isEarlyLeave = earlyLeaveMinutes > 0;
  const isIncomplete = !hasPair;

  const status = isIncomplete
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
    lateMinutes,
    graceMinutes,
    isLate,
    overtimeMinutes,
    earlyLeaveMinutes,
    isEarlyLeave,
    isIncomplete,
    status,
  };
}

function workDateForEvent(timestamp, settings) {
  const dateKey = toInputDate(timestamp);
  const date = parseInputDate(dateKey);
  const isSaturday = date.getDay() === 6;
  const shiftStart = isSaturday ? (settings.satShiftStart || '08:00') : settings.shiftStart;
  const shiftEnd = isSaturday ? (settings.satShiftEnd || '13:00') : settings.shiftEnd;

  const start = parseDateTime(dateKey, shiftStart);
  const end = normalizeShiftEnd(dateKey, shiftStart, shiftEnd);

  if (end > start && shiftEnd <= shiftStart && timestamp < start) {
    const previousDateKey = addDays(dateKey, -1);
    const prevDate = parseInputDate(previousDateKey);
    const prevIsSaturday = prevDate.getDay() === 6;
    const prevShiftStart = prevIsSaturday ? (settings.satShiftStart || '08:00') : settings.shiftStart;
    const prevShiftEnd = prevIsSaturday ? (settings.satShiftEnd || '13:00') : settings.shiftEnd;

    const previousEnd = normalizeShiftEnd(previousDateKey, prevShiftStart, prevShiftEnd);
    if (timestamp <= previousEnd) {
      return previousDateKey;
    }
  }

  return dateKey;
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

