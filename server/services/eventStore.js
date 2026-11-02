const { db, insertEvent } = require('./sqlite');

function getStoredEvents(deviceId) {
  if (!deviceId) throw new Error('Biometrico requerido.');
  return db.prepare(`SELECT e.device_id AS deviceId,e.employee_id AS employeeId,
    COALESCE(p.override_name,p.name) AS employeeName,e.timestamp,e.local_date AS localDate,
    e.local_time AS localTime,e.source,e.device_user_id AS deviceUserId,e.uid
    FROM events e JOIN employees p ON p.device_id=e.device_id AND p.employee_id=e.employee_id
    WHERE e.device_id=? ORDER BY e.timestamp`).all(String(deviceId));
}

function addStoredEvents(deviceId, events, source = 'manual') {
  if (!deviceId) throw new Error('Biometrico requerido.');
  const inserted = [];
  db.transaction(() => {
  for (const event of events) {
    const normalized = normalizeStoredEvent(deviceId, event, source);
    if (!normalized) {
      continue;
    }
    if (insertEvent(String(deviceId), normalized, source)) inserted.push(normalized);
  }

  })();

  return inserted;
}

function normalizeStoredEvent(deviceId, event, source) {
  const timestamp = coerceDate(event.timestamp || event.recordTime || event.attTime);
  const employeeId = cleanValue(event.employeeId || event.deviceUserId || event.userId || event.userSn);
  if (!timestamp || !employeeId) {
    return null;
  }

  return {
    deviceId: String(deviceId),
    employeeId,
    employeeName: cleanValue(event.employeeName) || `Empleado ${employeeId}`,
    deviceUserId: cleanValue(event.deviceUserId || event.userId || employeeId),
    uid: cleanValue(event.uid || event.userSn),
    timestamp: timestamp.toISOString(),
    localDate: toDateKey(timestamp),
    localTime: toTimeKey(timestamp),
    source,
  };
}

function parseAttendanceFile(content) {
  const events = [];
  const lines = String(content || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^pin\b|^user\b|^id\b/i.test(trimmed)) {
      continue;
    }

    const fields = trimmed.includes('\t')
      ? trimmed.split('\t').map((part) => part.trim())
      : trimmed.split(/[,\s;]+/).map((part) => part.trim()).filter(Boolean);

    const parsed = parseAttendanceFields(fields, trimmed);
    if (parsed) {
      events.push(parsed);
    }
  }

  return events;
}

function parseAttendanceFields(fields, rawLine) {
  const employeeId = cleanValue(fields[0]);
  if (!employeeId) {
    return null;
  }

  const joined = fields.join(' ');
  const match = joined.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  const timestamp = match ? parseDateTime(match[1], match[2]) : null;
  if (!timestamp) {
    return null;
  }

  return {
    employeeId,
    deviceUserId: employeeId,
    timestamp: timestamp.toISOString(),
    rawLine,
  };
}

function eventKey(event) {
  return [
    event.deviceId,
    cleanValue(event.employeeId || event.deviceUserId),
    cleanValue(event.timestamp),
    cleanValue(event.source),
  ].join('::');
}

function parseDateTime(dateValue, timeValue) {
  const [year, month, day] = dateValue.replace(/\//g, '-').split('-').map(Number);
  const [hour, minute, second = 0] = timeValue.split(':').map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function coerceDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toTimeKey(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

module.exports = {
  addStoredEvents,
  getStoredEvents,
  parseAttendanceFile,
};
