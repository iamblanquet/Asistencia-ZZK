const crypto = require('node:crypto');
const { db } = require('./sqlite');
const GENERAL_BASELINE = '0001-01-01';
const scheduleDefaults = { shiftStart: '08:00', shiftEnd: '17:00', satShiftStart: '08:00', satShiftEnd: '13:00', graceMinutes: 10 };

function reportDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const initializeGeneralSchedules = db.transaction((deviceId = null) => {
  const devices = db.prepare(`SELECT id,config FROM devices WHERE (? IS NULL OR id=?)
    AND NOT EXISTS (SELECT 1 FROM report_general_schedule_state WHERE device_id=devices.id)`).all(deviceId, deviceId);
  for (const device of devices) {
    const config = { ...scheduleDefaults, ...JSON.parse(device.config) };
    const settings = Object.fromEntries(Object.keys(scheduleDefaults).map(field => [field, config[field]]));
    if (config.sundayEnabled !== undefined) Object.assign(settings, {
      sundayEnabled: config.sundayEnabled, sunShiftStart: config.sunShiftStart || config.shiftStart,
      sunShiftEnd: config.sunShiftEnd || config.shiftEnd,
    });
    db.prepare('INSERT INTO report_general_schedule_state(device_id) VALUES (?)').run(device.id);
    db.prepare('INSERT INTO report_general_schedule_versions(device_id,effective_from,settings) VALUES (?,?,?)')
      .run(device.id, GENERAL_BASELINE, JSON.stringify(settings));
  }
});

function getGeneralSchedule(deviceId) {
  const state = db.prepare('SELECT revision FROM report_general_schedule_state WHERE device_id=?').get(deviceId);
  if (!state) return null;
  return { ...state, versions: db.prepare(`SELECT effective_from,settings FROM report_general_schedule_versions
    WHERE device_id=? ORDER BY effective_from`).all(deviceId)
    .map(value => ({ effectiveFrom: value.effective_from, settings: JSON.parse(value.settings) })) };
}

function currentGeneralSettings(deviceId, date = reportDate()) {
  return getGeneralSchedule(deviceId)?.versions.filter(value => value.effectiveFrom <= date).at(-1)?.settings || {};
}

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message });
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < GENERAL_BASELINE
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw invalid('Fecha de vigencia no valida.');
  }
  return value;
}

function validateSettings(value, previous = { sundayEnabled: false }) {
  const settings = {};
  for (const field of ['shiftStart', 'shiftEnd', 'satShiftStart', 'satShiftEnd']) {
    if (typeof value?.[field] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value[field])) {
      throw invalid('Las horas de entrada y salida deben ser validas.');
    }
    settings[field] = value[field];
  }
  if (settings.shiftStart === settings.shiftEnd || settings.satShiftStart === settings.satShiftEnd) {
    throw invalid('La entrada y la salida no pueden ser iguales.');
  }
  if (!Number.isInteger(value.graceMinutes) || value.graceMinutes < 0 || value.graceMinutes > 180) {
    throw invalid('La tolerancia de entrada debe ser un entero entre 0 y 180 minutos.');
  }
  settings.graceMinutes = value.graceMinutes;
  if (value.sundayEnabled !== undefined && typeof value.sundayEnabled !== 'boolean') {
    throw invalid('Indique si el domingo esta activado.');
  }
  settings.sundayEnabled = value.sundayEnabled ?? (previous.sundayEnabled !== false);
  settings.sunShiftStart = value.sunShiftStart ?? previous.sunShiftStart ?? settings.shiftStart;
  settings.sunShiftEnd = value.sunShiftEnd ?? previous.sunShiftEnd ?? settings.shiftEnd;
  if (settings.sundayEnabled) {
    for (const field of ['sunShiftStart', 'sunShiftEnd']) {
      if (typeof settings[field] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings[field])) {
        throw invalid('Las horas del domingo deben ser validas.');
      }
    }
    if (settings.sunShiftStart === settings.sunShiftEnd) throw invalid('La entrada y salida del domingo no pueden ser iguales.');
  } else {
    for (const [field, fallback] of [['sunShiftStart', settings.shiftStart], ['sunShiftEnd', settings.shiftEnd]]) {
      if (typeof settings[field] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings[field])) settings[field] = fallback;
    }
  }
  return settings;
}

function listScheduleGroups(deviceId) {
  const versions = db.prepare(`SELECT group_id,effective_from,settings FROM report_schedule_versions
    WHERE device_id=? ORDER BY effective_from`).all(deviceId);
  return db.prepare('SELECT id,name,revision FROM report_schedule_groups WHERE device_id=? ORDER BY name COLLATE NOCASE')
    .all(deviceId).map(group => ({ ...group, versions: versions.filter(v => v.group_id === group.id)
      .map(v => ({ effectiveFrom: v.effective_from, settings: JSON.parse(v.settings) })) }));
}

function getScheduleAssignments(deviceId) {
  const result = new Map();
  for (const row of db.prepare(`SELECT employee_id,effective_from,group_id FROM employee_schedule_assignments
    WHERE device_id=? ORDER BY effective_from`).all(deviceId)) {
    if (!result.has(row.employee_id)) result.set(row.employee_id, []);
    result.get(row.employee_id).push({ effectiveFrom: row.effective_from, groupId: row.group_id });
  }
  return result;
}

const saveGeneralSchedule = db.transaction((deviceId, input, actorId) => {
  if (!db.prepare('SELECT 1 FROM devices WHERE id=? AND deleted_at IS NULL').get(deviceId)) throw invalid('Biometrico no encontrado.', 404);
  const effectiveFrom = validateDate(input.effectiveFrom);
  if (effectiveFrom === GENERAL_BASELINE) throw invalid('El horario original se conserva. Seleccione una nueva fecha de vigencia.');
  const previous = getGeneralSchedule(deviceId);
  if (!previous || input.revision !== previous.revision) throw invalid('El horario general cambio. Vuelva a cargarlo antes de guardar.', 409);
  const settings = validateSettings(input.settings, previous.versions.filter(value => value.effectiveFrom <= effectiveFrom).at(-1)?.settings);
  db.prepare(`INSERT INTO report_general_schedule_versions(device_id,effective_from,settings) VALUES (?,?,?)
    ON CONFLICT(device_id,effective_from) DO UPDATE SET settings=excluded.settings`)
    .run(deviceId, effectiveFrom, JSON.stringify(settings));
  db.prepare('UPDATE report_general_schedule_state SET revision=revision+1 WHERE device_id=?').run(deviceId);
  db.prepare('INSERT INTO report_schedule_audit(device_id,group_id,actor_id,created_at,details) VALUES (?,?,?,?,?)')
    .run(deviceId, 'general', actorId, new Date().toISOString(), JSON.stringify({ action: 'general_schedule', effectiveFrom, previous, settings }));
  return getGeneralSchedule(deviceId);
});

function getEmployeeSchedule(deviceId, employeeId) {
  if (!db.prepare('SELECT 1 FROM employees WHERE device_id=? AND employee_id=?').get(deviceId, employeeId)) throw invalid('Colaborador no encontrado en este biometrico.', 404);
  const assignments = getScheduleAssignments(deviceId).get(employeeId) || [];
  return { assignments, revision: crypto.createHash('sha256').update(JSON.stringify(assignments)).digest('hex') };
}

const assignEmployeeSchedule = db.transaction((deviceId, employeeId, input, actorId) => {
  if (!db.prepare('SELECT 1 FROM devices WHERE id=? AND deleted_at IS NULL').get(deviceId)) throw invalid('Biometrico no encontrado.', 404);
  const effectiveFrom = validateDate(input.effectiveFrom);
  const previous = getEmployeeSchedule(deviceId, employeeId);
  if (input.revision !== previous.revision) throw invalid('La asignacion cambio. Vuelva a cargarla antes de guardar.', 409);
  if (input.groupId !== null) {
    if (typeof input.groupId !== 'string' || !db.prepare(`SELECT 1 FROM report_schedule_versions
      WHERE device_id=? AND group_id=? AND effective_from<=?`).get(deviceId, input.groupId, effectiveFrom)) {
      throw invalid('El horario seleccionado no existe o aun no tiene vigencia en esa fecha.');
    }
  }
  const oldGroup = previous.assignments.filter(value => value.effectiveFrom <= effectiveFrom).at(-1)?.groupId || null;
  db.prepare(`INSERT INTO employee_schedule_assignments(device_id,employee_id,effective_from,group_id) VALUES (?,?,?,?)
    ON CONFLICT(device_id,employee_id,effective_from) DO UPDATE SET group_id=excluded.group_id`)
    .run(deviceId, employeeId, effectiveFrom, input.groupId);
  for (const group of new Set([oldGroup, input.groupId].filter(Boolean))) {
    db.prepare('UPDATE report_schedule_groups SET revision=revision+1 WHERE device_id=? AND id=?').run(deviceId, group);
  }
  db.prepare('INSERT INTO report_schedule_audit(device_id,group_id,actor_id,created_at,details) VALUES (?,?,?,?,?)')
    .run(deviceId, input.groupId || 'general', actorId, new Date().toISOString(),
      JSON.stringify({ action: 'assign', employeeId, effectiveFrom, previous, groupId: input.groupId }));
  return getEmployeeSchedule(deviceId, employeeId);
});

const saveScheduleGroup = db.transaction((deviceId, groupId, input, actorId) => {
  if (!db.prepare('SELECT 1 FROM devices WHERE id=? AND deleted_at IS NULL').get(deviceId)) {
    throw invalid('Biometrico no encontrado.', 404);
  }
  const effectiveFrom = validateDate(input.effectiveFrom);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 60) throw invalid('El nombre del horario debe tener entre 1 y 60 caracteres.');
  if (!Array.isArray(input.employeeIds) || input.employeeIds.length > 10000
    || input.employeeIds.some(id => typeof id !== 'string' || !id)) {
    throw invalid('Seleccione los colaboradores del horario.');
  }
  const selected = new Set(input.employeeIds);
  const employees = new Set(db.prepare('SELECT employee_id FROM employees WHERE device_id=?').all(deviceId).map(e => e.employee_id));
  if ([...selected].some(id => !employees.has(id))) throw invalid('Un colaborador no pertenece a este biometrico.');

  const groups = listScheduleGroups(deviceId);
  const previous = groupId ? groups.find(g => g.id === groupId) : null;
  if (groupId && !previous) throw invalid('Horario no encontrado.', 404);
  if (previous && input.revision !== previous.revision) {
    throw invalid('El horario cambio en otra sesion. Vuelva a cargarlo antes de guardar.', 409);
  }
  const settings = validateSettings(input.settings, previous?.versions.filter(value => value.effectiveFrom <= effectiveFrom).at(-1)?.settings);
  if (groups.some(g => g.id !== groupId && g.name.toLowerCase() === name.toLowerCase())) {
    throw invalid('Ya existe un horario con ese nombre.', 409);
  }
  const id = groupId || `schedule-${crypto.randomUUID()}`;
  const assignments = getScheduleAssignments(deviceId);
  const changes = [];
  for (const employeeId of employees) {
    const history = assignments.get(employeeId) || [];
    const current = history.filter(v => v.effectiveFrom <= effectiveFrom).at(-1)?.groupId || null;
    if (selected.has(employeeId) && current !== id) changes.push({ employeeId, from: current, to: id });
    if (!selected.has(employeeId) && current === id) changes.push({ employeeId, from: id, to: null });
  }
  if (previous) {
    db.prepare('UPDATE report_schedule_groups SET name=?,revision=revision+1 WHERE device_id=? AND id=?').run(name, deviceId, id);
  } else {
    db.prepare('INSERT INTO report_schedule_groups(device_id,id,name) VALUES (?,?,?)').run(deviceId, id, name);
  }
  db.prepare(`INSERT INTO report_schedule_versions(device_id,group_id,effective_from,settings) VALUES (?,?,?,?)
    ON CONFLICT(device_id,group_id,effective_from) DO UPDATE SET settings=excluded.settings`)
    .run(deviceId, id, effectiveFrom, JSON.stringify(settings));
  const putAssignment = db.prepare(`INSERT INTO employee_schedule_assignments(device_id,employee_id,effective_from,group_id)
    VALUES (?,?,?,?) ON CONFLICT(device_id,employee_id,effective_from) DO UPDATE SET group_id=excluded.group_id`);
  for (const change of changes) putAssignment.run(deviceId, change.employeeId, effectiveFrom, change.to);
  // A bulk move also changes the membership of the source groups.
  for (const source of new Set(changes.map(c => c.from).filter(value => value && value !== id))) {
    db.prepare('UPDATE report_schedule_groups SET revision=revision+1 WHERE device_id=? AND id=?').run(deviceId, source);
  }
  db.prepare('INSERT INTO report_schedule_audit(device_id,group_id,actor_id,created_at,details) VALUES (?,?,?,?,?)')
    .run(deviceId, id, actorId, new Date().toISOString(), JSON.stringify({ effectiveFrom, previous, name, settings, changes }));
  return listScheduleGroups(deviceId).find(g => g.id === id);
});

module.exports = { listScheduleGroups, getScheduleAssignments, saveScheduleGroup, initializeGeneralSchedules,
  getGeneralSchedule, currentGeneralSettings, saveGeneralSchedule, getEmployeeSchedule, assignEmployeeSchedule };
