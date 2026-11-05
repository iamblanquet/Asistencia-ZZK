const crypto = require('node:crypto');
const { enrollmentError } = require('./zkEnrollment');
const { captureBackup } = require('./biometricBackup');
const { MAX_ARCHIVE } = require('./biometricArchive');
const { identify, previewRecovery, restoreArchivedUser } = require('./biometricRecovery');

function createBiometricBackupManager({ db, withDevice, getDeviceById, getRealtimeStatus, saveEmployees,
  isDeviceBusy = () => false, capture = captureBackup, identifyDevice = identify,
  preview = previewRecovery, restore = restoreArchivedUser, archiveService, now = Date.now }) {
  const pending = new Map(), previews = new Map(), failures = new Map();
  const iso = () => new Date(now()).toISOString();
  db.prepare("UPDATE biometric_backup_actions SET status='needs_attention',finished_at=? WHERE finished_at IS NULL").run(iso());
  function available(device) {
    if (pending.has(device.id) || isDeviceBusy(device.id)) throw enrollmentError('Hay otra operacion en curso en este biometrico.');
    if (pending.size >= 2) throw enrollmentError('Hay otros respaldos en proceso. Espere antes de reintentar.', 429);
    const realtime = getRealtimeStatus(device.id);
    if (realtime.active || realtime.connecting) throw enrollmentError('Detenga la lectura en tiempo real antes de respaldar o restaurar.');
  }
  function sameDevice(device) {
    const current = getDeviceById(device.id);
    if (!current || current.ip !== device.ip || Number(current.port) !== Number(device.port)) throw enrollmentError('El biometrico cambio de configuracion. Vuelva a consultar.');
  }
  function expire() {
    for (const [id, value] of previews) if (value.expires <= now()) previews.delete(id);
    for (const [id, value] of failures) if (value.expires <= now()) failures.delete(id);
    while (previews.size >= 20) previews.delete(previews.keys().next().value);
    while (failures.size > 1000) failures.delete(failures.keys().next().value);
  }
  async function unlock(body, actorId, deviceId) {
    expire();
    const failure = failures.get(actorId);
    if (failure?.count >= 5) throw enrollmentError('Demasiados intentos fallidos. Espere 10 minutos antes de abrir otro respaldo.', 429);
    if (typeof body?.archive !== 'string' || body.archive.length > Math.ceil(MAX_ARCHIVE / 3) * 4) throw enrollmentError('Seleccione un respaldo cifrado de hasta 16 MB.', 413);
    try {
      const payload = await archiveService.decrypt(body.archive, { recoveryKey: body.recoveryKey, password: body.password });
      failures.delete(actorId);
      return payload;
    } catch (error) {
      if (error.code === 'BACKUP_AUTH_FAILED') {
        failures.set(actorId, { count: (failure?.count || 0) + 1, expires: failure?.expires || now() + 600000 });
        const sha = crypto.createHash('sha256').update(Buffer.from(body.archive, 'base64')).digest('hex');
        const exported = db.prepare(`SELECT id FROM biometric_backup_actions WHERE device_id=? AND action='export' AND status='success'
          AND json_extract(details,'$.sha256')=? LIMIT 1`).get(deviceId, sha);
        if (exported) {
          error.publicMessage = 'El archivo coincide integramente con el respaldo descargado, pero no se pudo verificar con esta clave. Seleccione su clave de recuperacion original.';
        }
      }
      throw error;
    }
  }
  function run(device, actorId, action, employeeId, work) {
    available(device);
    const id = crypto.randomUUID();
    const state = { writeAttempted: false, work: null };
    db.prepare(`INSERT INTO biometric_backup_actions(id,device_id,actor_id,action,employee_id,status,created_at,details)
      VALUES (?,?,?,?,?,'running',?,'{}')`).run(id, device.id, actorId, action, employeeId || null, iso());
    pending.set(device.id, state);
    const control = { beforeWrite: () => sameDevice(device), writeAttempted: () => { state.writeAttempted = true; } };
    state.work = Promise.resolve().then(() => work(control)).then(({ value, details }) => {
      db.prepare("UPDATE biometric_backup_actions SET status='success',finished_at=?,details=? WHERE id=?")
        .run(iso(), JSON.stringify(details), id);
      return { ...value, auditId: id };
    }).catch(error => {
      const message = state.writeAttempted ? 'La carga fue enviada, pero requiere revision. Consulte el estado del reloj antes de reintentar.'
        : error.publicMessage || 'No se pudo verificar el respaldo o el biometrico. No se realizaron cambios.';
      db.prepare('UPDATE biometric_backup_actions SET status=?,finished_at=?,details=? WHERE id=?')
        .run(state.writeAttempted ? 'needs_attention' : 'failed', iso(), JSON.stringify({ message, ...(error.code && { code: error.code }) }), id);
      const safe = enrollmentError(message, state.writeAttempted ? 503 : error.statusCode || 503);
      safe.needsAttention = state.writeAttempted;
      safe.code = error.code;
      throw safe;
    }).finally(() => pending.delete(device.id));
    return state.work;
  }
  const archiveHash = body => crypto.createHash('sha256').update(body.archive).digest('hex');
  return {
    isBusy: deviceId => pending.has(deviceId),
    history(deviceId) {
      return db.prepare('SELECT * FROM biometric_backup_actions WHERE device_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10').all(deviceId)
        .map(row => ({ id: row.id, action: row.action, employeeId: row.employee_id, status: row.status, createdAt: row.created_at,
          finishedAt: row.finished_at, details: JSON.parse(row.details) }));
    },
    download(device, actorId, body) {
      if (body?.confirmed !== true) throw enrollmentError('Confirme el dispositivo seleccionado.', 400);
      if (body.password !== undefined) throw enrollmentError('Recargue ASISTO para generar respaldos sin contrasena manual.', 400);
      return run(device, actorId, 'export', null, async control => {
        const payload = await withDevice(device, async connected => {
          control.beforeWrite();
          const identity = await identifyDevice(connected, device);
          return capture(connected, identity);
        });
        const buffer = await archiveService.encrypt(payload);
        await archiveService.decrypt(buffer.toString('base64'));
        const filename = `asisto-${payload.device.serial.replace(/[^a-z0-9_-]/gi, '_')}-${payload.createdAt.replace(/[^0-9TZ]/g, '')}.zkbio`;
        return { value: { buffer, filename, verified: true }, details: { filename, verified: true, createdAt: payload.createdAt, serial: payload.device.serial,
          users: payload.manifest.usersCount, fingerprints: payload.manifest.templatesCount, sha256: crypto.createHash('sha256').update(buffer).digest('hex') } };
      });
    },
    recoveryKey(device, actorId) {
      return run(device, actorId, 'export', null, async control => {
        control.beforeWrite();
        const result = await archiveService.exportKey();
        return { value: { buffer: result.buffer, filename: result.filename, verified: true },
          details: { type: 'recovery-key', filename: result.filename, keyId: result.keyId } };
      });
    },
    preview(device, actorId, body) {
      return run(device, actorId, 'preview', null, async control => {
        const payload = await unlock(body, actorId, device.id);
        const result = await withDevice(device, async connected => { control.beforeWrite(); return preview(connected, device, payload); });
        expire();
        for (const [id, value] of previews) if (value.deviceId === device.id && value.actorId === actorId) previews.delete(id);
        const token = crypto.randomUUID(), expires = now() + 300000;
        previews.set(token, { deviceId: device.id, actorId, archiveHash: archiveHash(body), revision: result.revision,
          employees: new Set(result.employees.filter(item => item.eligible).map(item => item.employeeId)), expires });
        return { value: { token, expiresAt: new Date(expires).toISOString(),
          backup: { createdAt: payload.createdAt, device: result.device, users: payload.manifest.usersCount, fingerprints: payload.manifest.templatesCount },
          employees: result.employees }, details: { createdAt: payload.createdAt, serial: result.device.serial,
          users: payload.manifest.usersCount, fingerprints: payload.manifest.templatesCount } };
      });
    },
    restore(device, actorId, body) {
      if (!/^[1-9]\d{0,8}$/.test(body?.employeeId || '') || body.confirmationId !== body.employeeId || body.confirmed !== true) throw enrollmentError('Escriba el ID exacto y confirme la recuperacion.', 400);
      const entry = previews.get(body.token);
      if (!entry || entry.expires <= now() || entry.deviceId !== device.id || entry.actorId !== actorId || !entry.employees.has(body.employeeId) ||
          typeof body.archive !== 'string' || entry.archiveHash !== archiveHash(body)) throw enrollmentError('La vista previa vencio o no corresponde al archivo, usuario o biometrico. Consulte de nuevo.');
      available(device);
      previews.delete(body.token);
      return run(device, actorId, 'restore', body.employeeId, async control => {
        const payload = await unlock(body, actorId, device.id);
        const result = await withDevice(device, async connected => {
          control.beforeWrite();
          return restore(connected, device, payload, body.employeeId, { ...control, revision: entry.revision });
        });
        saveEmployees(device.id, result.users);
        return { value: { ok: true, employee: result.employee, fingerprintCount: result.fingerprintCount,
          message: 'Usuario y huellas recuperados y verificados. Compruebe el reconocimiento del dedo en el reloj.', physicalRecognitionTested: false },
        details: { employeeId: body.employeeId, fingerprints: result.fingerprintCount, serial: payload.device.serial, verified: true } };
      });
    },
    async shutdown() { await Promise.allSettled([...pending.values()].map(state => state.work)); previews.clear(); },
  };
}

module.exports = { createBiometricBackupManager };
