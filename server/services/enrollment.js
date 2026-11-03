const crypto = require('node:crypto');
const { enrollmentError, validateEnrollment, nextEmployeeId, readEnrollmentUsers, readEnrollmentSnapshot, captureFingerprint } = require('./zkEnrollment');
const TERMINAL = new Set(['completed', 'cancelled', 'timeout', 'failed', 'needs_attention']);

function createEnrollmentManager({ db, withDevice, getDeviceById, getRealtimeStatus, saveEmployees,
  capture = captureFingerprint, read = readEnrollmentSnapshot, readUsers = readEnrollmentUsers, reservedEmployeeIds = () => [], isDeviceBusy = () => false }) {
  const running = new Map();
  const clock = () => new Date().toISOString();
  db.prepare(`UPDATE enrollment_jobs SET status='needs_attention',message=?,updated_at=?,finished_at=?
    WHERE finished_at IS NULL`).run('El servicio se reinicio durante el registro. Revise el reloj antes de reintentar.', clock(), clock());
  function job(id, deviceId) {
    const row = db.prepare('SELECT * FROM enrollment_jobs WHERE id=? AND device_id=?').get(id, deviceId);
    if (!row) throw enrollmentError('Registro no encontrado para este biometrico.', 404);
    return { id: row.id, deviceId: row.device_id, employeeId: row.employee_id, fingerIndex: row.finger_index,
      status: row.status, message: row.message, createdAt: row.created_at, updatedAt: row.updated_at,
      deadline: row.deadline, finishedAt: row.finished_at, cancelRequested: Boolean(row.cancel_requested),
      result: row.result ? JSON.parse(row.result) : null };
  }
  function update(id, deviceId, changes) {
    const current = job(id, deviceId);
    const status = changes.status || current.status;
    const result = { ...(current.result || {}), ...(changes.result || {}) };
    if (changes.employeeCreated) result.employeeCreated = true;
    db.prepare(`UPDATE enrollment_jobs SET employee_id=?,status=?,message=?,updated_at=?,finished_at=?,deadline=?,result=? WHERE id=?`)
      .run(changes.employeeId || current.employeeId, status, changes.message || current.message, clock(), TERMINAL.has(status) ? clock() : null,
        changes.deadline || current.deadline, Object.keys(result).length ? JSON.stringify(result) : null, id);
  }
  function assertAvailable(device) {
    if (running.has(device.id) || isDeviceBusy(device.id)) throw enrollmentError('Ya hay una operacion en curso en este biometrico.');
    const realtime = getRealtimeStatus(device.id);
    if (realtime.active || realtime.connecting) throw enrollmentError('Detenga la lectura en tiempo real antes de registrar huellas.');
  }
  return {
    isBusy(deviceId) { return running.has(deviceId); },
    job,
    latest(deviceId) {
      const row = db.prepare('SELECT id FROM enrollment_jobs WHERE device_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(deviceId);
      return row ? job(row.id, deviceId) : null;
    },
    async nextEmployee(device) {
      assertAvailable(device);
      return withDevice(device, async connected => {
        const snapshot = await readUsers(connected);
        return { employeeId: nextEmployeeId(snapshot.users, reservedEmployeeIds(device.id)) };
      });
    },
    async inspect(device, employeeId) {
      if (!/^[1-9]\d{0,8}$/.test(String(employeeId || ''))) throw enrollmentError('ID de empleado invalido.', 400);
      assertAvailable(device);
      return withDevice(device, async connected => {
        const snapshot = await read(connected);
        const employee = snapshot.users.find(item => item.employeeId === String(employeeId));
        return { exists: Boolean(employee), employee: employee ? { employeeId: employee.employeeId, name: employee.name } : null,
          occupiedSlots: employee ? Array.from({ length: 10 }, (_, slot) => slot).filter(slot => snapshot.templates.has(`${employee.uid}:${slot}`)) : [] };
      });
    },
    start(device, actorId, body) {
      const input = validateEnrollment(body);
      assertAvailable(device);
      const id = crypto.randomUUID();
      const controller = new AbortController();
      db.prepare(`INSERT INTO enrollment_jobs(id,device_id,employee_id,finger_index,actor_id,status,message,created_at,updated_at,result)
        VALUES (?,?,?,?,?,'queued',?,?,?,?)`).run(id, device.id, input.employeeId, input.fingerIndex, actorId,
          'Esperando conexion con el biometrico.', clock(), clock(), JSON.stringify({ createEmployee: input.createEmployee }));
      const state = { controller, work: null };
      running.set(device.id, state);
      state.work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return withDevice(device, async connected => {
        controller.signal.throwIfAborted();
        const current = getDeviceById(device.id);
        if (!current || current.ip !== device.ip || Number(current.port) !== Number(device.port)) throw enrollmentError('La configuracion del biometrico cambio. Vuelva a confirmar el registro.');
        update(id, device.id, { status: 'checking', message: 'Comprobando empleado y posicion del dedo.' });
        const result = await capture(connected, input, {
          signal: controller.signal, report: changes => update(id, device.id, changes),
        }, { saveEmployees: values => saveEmployees(device.id, values), reservedEmployeeIds: () => reservedEmployeeIds(device.id) });
        update(id, device.id, { status: result.status, message: result.message, result });
        });
      }).catch(error => {
        update(id, device.id, { status: error.name === 'AbortError' ? 'cancelled' : 'failed',
          message: error.name === 'AbortError' ? 'Registro cancelado antes de activar la captura.' : (error.publicMessage || error.message || 'No se pudo registrar la huella.') });
      }).finally(() => running.delete(device.id));
      state.work.catch(error => console.error('[enrollment] No se pudo actualizar la auditoria:', error.message));
      return job(id, device.id);
    },
    cancel(id, deviceId, actorId) {
      const current = job(id, deviceId);
      if (TERMINAL.has(current.status)) return current;
      db.prepare('UPDATE enrollment_jobs SET cancel_requested=1,updated_at=? WHERE id=?').run(clock(), id);
      update(id, deviceId, { message: 'Cancelando y comprobando el estado del reloj.', result: { cancelledBy: actorId } });
      running.get(deviceId)?.controller.abort();
      return job(id, deviceId);
    },
    async shutdown() {
      const tasks = [...running.values()];
      tasks.forEach(state => state.controller.abort());
      await Promise.allSettled(tasks.map(state => state.work));
    },
  };
}

module.exports = { createEnrollmentManager };
