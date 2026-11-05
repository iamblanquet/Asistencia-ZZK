const crypto = require('node:crypto');
const { enrollmentError, readEnrollmentSnapshot } = require('./zkEnrollment');
const { validEmployeeId, validName, previewUser, mutateDeviceUser } = require('./zkUserManagement');

function createDeviceUserManager({ db, withDevice, getDeviceById, getRealtimeStatus, saveEmployees,
  isEnrollmentBusy, read = readEnrollmentSnapshot, mutate = mutateDeviceUser, now = Date.now, authorizeActor = () => null }) {
  const pending = new Map();
  const previews = new Map();
  const iso = () => new Date(now()).toISOString();
  db.prepare("UPDATE device_user_actions SET status='needs_attention',finished_at=? WHERE finished_at IS NULL").run(iso());
  function available(device) {
    if (pending.has(device.id) || isEnrollmentBusy(device.id)) throw enrollmentError('Hay otra operacion en curso en este biometrico.');
    const realtime = getRealtimeStatus(device.id);
    if (realtime.active || realtime.connecting) throw enrollmentError('Detenga la lectura en tiempo real antes de administrar usuarios.');
  }
  function sameDevice(device) {
    const current = getDeviceById(device.id);
    if (!current || current.ip !== device.ip || Number(current.port) !== Number(device.port)) throw enrollmentError('El biometrico cambio de configuracion. Consulte de nuevo antes de confirmar.');
  }
  function access(device, actorId, target = null) {
    const permission = authorizeActor(device.id, actorId);
    if (!permission) throw enrollmentError('Ya no tiene permiso para administrar usuarios en este biometrico.', 403);
    if (target && target.role !== 0 && permission.allowPrivilegedUsers !== true) {
      throw enrollmentError('Solo un administrador de ASISTO puede editar usuarios con privilegios en el biometrico.', 403);
    }
  }
  function expire() {
    for (const [id, value] of previews) if (value.expires <= now()) previews.delete(id);
    while (previews.size >= 100) previews.delete(previews.keys().next().value);
  }
  return {
    isBusy(deviceId) { return pending.has(deviceId); },
    async preview(device, actorId, employeeId) {
      access(device, actorId);
      employeeId = validEmployeeId(employeeId);
      available(device);
      return withDevice(device, async connected => {
        sameDevice(device);
        access(device, actorId);
        const snapshot = await read(connected);
        const target = previewUser(snapshot, employeeId);
        access(device, actorId, target.user);
        expire();
        const token = crypto.randomUUID();
        previews.set(token, { deviceId: device.id, employeeId, actorId, expires: now() + 5 * 60000,
          uid: target.user.uid, role: target.user.role, userHash: target.userHash, fingerprintRevision: target.fingerprintRevision });
        return { token, employee: { employeeId, name: target.user.name, role: target.user.role },
          fingerprintCount: target.fingerprintCount, canDelete: target.user.role === 0 };
      });
    },
    execute(device, actorId, employeeId, action, body) {
      access(device, actorId);
      employeeId = validEmployeeId(employeeId);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw enrollmentError('Datos de confirmacion invalidos.', 400);
      if (!['rename', 'delete'].includes(action)) throw enrollmentError('Operacion invalida.', 400);
      if (body.confirmed !== true) throw enrollmentError('Confirme el colaborador y el biometrico seleccionados.', 400);
      const input = action === 'rename' ? { name: validName(body.name) } : {};
      if (action === 'delete' && (body.confirmationId !== employeeId || body.deleteFingerprints !== true)) {
        throw enrollmentError('Escriba el ID y confirme la eliminacion del usuario y sus huellas.', 400);
      }
      available(device);
      const revision = previews.get(body.token);
      if (!revision || revision.expires <= now() || revision.deviceId !== device.id || revision.employeeId !== employeeId || revision.actorId !== actorId) {
        throw enrollmentError('La confirmacion vencio o no corresponde al usuario. Vuelva a consultar.');
      }
      const authorize = () => { sameDevice(device); access(device, actorId, revision); };
      authorize();
      if (action === 'delete' && revision.role !== 0) throw enrollmentError('No se permite eliminar usuarios con privilegios desde ASISTO.', 403);
      previews.delete(body.token);
      const auditId = crypto.randomUUID();
      db.prepare(`INSERT INTO device_user_actions(id,device_id,employee_id,actor_id,action,status,created_at,details)
        VALUES (?,?,?,?,?,'running',?,?)`).run(auditId, device.id, employeeId, actorId, action, iso(), JSON.stringify(input));
      let writeAttempted = false;
      const work = Promise.resolve().then(() => {
        authorize();
        return withDevice(device, async connected => {
          authorize();
          const result = await mutate(connected, action, employeeId, input, {
            revision, beforeWrite: authorize, writeAttempted: () => { writeAttempted = true; },
          });
          db.transaction(() => {
            saveEmployees(device.id, result.users);
            if (action === 'rename') db.prepare('UPDATE employees SET name=?,override_name=? WHERE device_id=? AND employee_id=?')
              .run(input.name, input.name, device.id, employeeId);
            // The deleted row remains for attendance history and automatic ID allocation.
            db.prepare("UPDATE device_user_actions SET status='success',finished_at=?,details=? WHERE id=?")
              .run(iso(), JSON.stringify({ ...input, previousName: result.previousName, removedFingerprints: result.removedFingerprints }), auditId);
          })();
          return { ok: true, auditId, status: 'success', message: action === 'rename' ? 'Nombre actualizado y verificado en el biometrico.' : 'Usuario eliminado del biometrico. El historial de asistencias se conserva.' };
        });
      }).catch(error => {
        db.prepare('UPDATE device_user_actions SET status=?,finished_at=?,details=? WHERE id=?')
          .run(writeAttempted ? 'needs_attention' : 'failed', iso(), JSON.stringify({ ...input, error: error.publicMessage || error.message }), auditId);
        if (writeAttempted) {
          error.needsAttention = true;
          error.publicMessage = 'La orden fue enviada, pero no se pudo verificar el resultado. Consulte el usuario en el reloj antes de reintentar.';
        }
        throw error;
      }).finally(() => pending.delete(device.id));
      pending.set(device.id, work);
      return work;
    },
    async shutdown() { await Promise.allSettled([...pending.values()]); },
  };
}

module.exports = { createDeviceUserManager };
