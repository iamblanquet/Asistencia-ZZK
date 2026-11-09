const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const key = (id, timestamp) => JSON.stringify([String(id).trim(), timestamp]);

function createAttendanceIdentityRepair({ db, saveEmployees, addStoredEvents, recordSyncSuccess }) {
  function state(deviceId, connection = db) {
    return {
      events: connection.prepare('SELECT * FROM events WHERE device_id=? ORDER BY employee_id,timestamp').all(deviceId),
      employees: connection.prepare('SELECT * FROM employees WHERE device_id=? ORDER BY employee_id').all(deviceId),
      device: connection.prepare('SELECT config FROM devices WHERE id=?').get(deviceId),
    };
  }
  const revision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

  function preview(device, download, { rebuild = false, expectedUsers } = {}) {
    if (rebuild && device.currentUsersOnly !== true) throw new Error('La reconstruccion requiere una base limitada al padron actual.');
    if (download.device.id !== device.id || download.device.ip !== device.ip || download.connectionType !== 'tcp') {
      throw new Error('La reparacion requiere una lectura TCP del mismo biometrico.');
    }
    if (!Number.isInteger(download.deviceInfo?.logCounts) || !Number.isInteger(download.deviceInfo?.userCounts) ||
        download.events.length < download.deviceInfo.logCounts ||
        new Set(download.employees.map(employee => employee.employeeId)).size !== download.deviceInfo.userCounts) {
      throw new Error('No se puede reparar con un historial o padron incompleto.');
    }
    if (download.events.some(event => event.identitySource !== 'employee-id' || event.employeeId !== event.deviceUserId)) {
      throw new Error('El historial no identifica explicitamente al colaborador de cada checada.');
    }
    if (expectedUsers !== undefined && download.employees.length !== expectedUsers) throw new Error('El numero de colaboradores del reloj cambio. No se modifico la base.');
    const before = state(device.id);
    const stored = before.events.filter(event => event.source === 'device');
    const wire = new Set(download.events.map(event => key(event.deviceUserId, event.timestamp)));
    const unverified = stored.filter(event => !event.device_user_id?.trim() || !wire.has(key(event.device_user_id, event.timestamp)));
    if (unverified.length && !rebuild) throw new Error(`${unverified.length} checadas guardadas no se pudieron comprobar en el reloj. No se modifico la base.`);
    const currentIds = new Set(download.employees.map(employee => employee.employeeId));
    const selected = download.events.filter(event => device.currentUsersOnly !== true || currentIds.has(event.employeeId));
    const wrong = stored.filter(event => event.employee_id !== event.device_user_id.trim());
    const retained = event => device.currentUsersOnly !== true || currentIds.has(event.device_user_id.trim());
    return {
      deviceId: device.id,
      rebuild,
      expectedUsers,
      revision: revision(before),
      downloadRevision: revision(download),
      summary: {
        clockEvents: download.events.length,
        currentCollaborators: currentIds.size,
        previousDeviceEvents: stored.length,
        selectedDeviceEvents: new Set(selected.map(event => key(event.employeeId, event.timestamp))).size,
        misassignedEvents: wrong.length,
        reassignedEvents: wrong.filter(retained).length,
        misassignedHistoricalEventsExcluded: wrong.filter(event => !retained(event)).length,
        historicalEventsExcluded: stored.filter(event => !retained(event)).length,
        unverifiedStoredDeviceEvents: unverified.length,
        otherSourceEventsPreserved: rebuild ? 0 : before.events.length - stored.length,
        otherSourceEventsExcluded: rebuild ? before.events.length - stored.length : 0,
      },
    };
  }

  function apply(device, download, plan, backupPath) {
    if (!backupPath) throw new Error('La reparacion requiere un respaldo previo.');
    const checked = preview(device, download, { rebuild: plan.rebuild, expectedUsers: plan.expectedUsers });
    if (checked.revision !== plan.revision || checked.deviceId !== plan.deviceId ||
        checked.downloadRevision !== plan.downloadRevision ||
        JSON.stringify(checked.summary) !== JSON.stringify(plan.summary)) throw new Error('La base o la lectura cambio despues de la vista previa. Vuelva a consultar.');
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      if (backup.pragma('quick_check', { simple: true }) !== 'ok' || revision(state(device.id, backup)) !== plan.revision) {
        throw new Error('El respaldo no coincide con la base que se va a reparar.');
      }
    } finally { backup.close(); }
    return db.transaction(() => {
      if (revision(state(device.id)) !== plan.revision) throw new Error('La base cambio durante el respaldo. No se aplico la reparacion.');
      saveEmployees(device.id, download.employees);
      const currentIds = new Set(download.employees.map(employee => employee.employeeId));
      const selected = download.events.filter(event => device.currentUsersOnly !== true || currentIds.has(event.employeeId));
      // Rebuilds use only the clock; regular repairs preserve other event sources.
      db.prepare(plan.rebuild ? 'DELETE FROM events WHERE device_id=?'
        : "DELETE FROM events WHERE device_id=? AND source='device'").run(device.id);
      addStoredEvents(device.id, selected, 'device');
      if (plan.rebuild) {
        const retired = db.prepare(`SELECT employee_id FROM employees WHERE device_id=? AND employee_id NOT IN
          (SELECT employee_id FROM employee_device_status WHERE device_id=? AND present=1)`).all(device.id, device.id);
        for (const row of retired) {
          db.prepare('DELETE FROM employee_schedule_assignments WHERE device_id=? AND employee_id=?').run(device.id, row.employee_id);
          db.prepare('DELETE FROM employee_device_status WHERE device_id=? AND employee_id=?').run(device.id, row.employee_id);
          db.prepare('DELETE FROM employees WHERE device_id=? AND employee_id=?').run(device.id, row.employee_id);
        }
      }
      recordSyncSuccess(device.id, download.deviceInfo);
      if (db.pragma('foreign_key_check').length) throw new Error('La reparacion contiene referencias invalidas.');
      const invalid = db.prepare("SELECT COUNT(*) AS count FROM events WHERE device_id=? AND source='device' AND employee_id<>device_user_id").get(device.id).count;
      if (invalid) throw new Error('Persisten checadas con identidades distintas.');
      const savedDeviceRows = db.prepare("SELECT employee_id,timestamp,device_user_id,uid FROM events WHERE device_id=? AND source='device'").all(device.id);
      const expected = new Map(selected.map(event => [key(event.employeeId, event.timestamp), event]));
      for (const row of savedDeviceRows) {
        const event = expected.get(key(row.employee_id, row.timestamp));
        if (!event || row.device_user_id !== event.deviceUserId || row.uid !== event.uid) {
          throw new Error('Una checada guardada no coincide con el ID y UID originales de la descarga.');
        }
      }
      if (plan.rebuild && (savedDeviceRows.length !== expected.size ||
          db.prepare('SELECT COUNT(*) AS count FROM employees WHERE device_id=?').get(device.id).count !== currentIds.size)) {
        throw new Error('La reconstruccion no coincide con el padron y las checadas del reloj.');
      }
      db.exec(`CREATE TABLE IF NOT EXISTS attendance_identity_repairs (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), created_at TEXT NOT NULL,
        backup_path TEXT NOT NULL, summary TEXT NOT NULL CHECK(json_valid(summary))
      )`);
      const id = crypto.randomUUID();
      const summary = { ...plan.summary, mode: plan.rebuild ? 'clock-current-roster-rebuild' : 'identity-repair',
        savedEvents: db.prepare('SELECT COUNT(*) AS count FROM events WHERE device_id=?').get(device.id).count };
      db.prepare('INSERT INTO attendance_identity_repairs VALUES (?,?,?,?,?)')
        .run(id, device.id, new Date().toISOString(), backupPath, JSON.stringify(summary));
      return { id, backupPath, ...summary };
    }).immediate();
  }

  return { preview, apply };
}

module.exports = { createAttendanceIdentityRepair };
