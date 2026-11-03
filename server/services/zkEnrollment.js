const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { COMMANDS: C, REQUEST_DATA } = require('zklib-js/constants');
const { createTCPHeader, decodeUserData72 } = require('zklib-js/utils');
const { readTcpPreparedData, validateRecordBuffer } = require('./zkTcpDownload');

function enrollmentError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode, publicMessage: message });
}

function validateEnrollment(input) {
  if (!/^[1-9]\d{0,8}$/.test(String(input.employeeId || ''))) throw enrollmentError('Use un ID numerico positivo sin ceros iniciales (hasta 9 digitos).', 400);
  if (!Number.isInteger(input.fingerIndex) || input.fingerIndex < 0 || input.fingerIndex > 9) throw enrollmentError('Seleccione un dedo valido.', 400);
  if (input.confirmed !== true || input.consent !== true) throw enrollmentError('Confirme el dispositivo y el consentimiento para registrar la huella.', 400);
  if (input.createEmployee && (typeof input.name !== 'string' || !input.name.trim() || Buffer.byteLength(input.name.trim(), 'utf8') > 24)) {
    throw enrollmentError('El nombre debe ocupar entre 1 y 24 bytes UTF-8.', 400);
  }
  return { employeeId: String(input.employeeId), fingerIndex: input.fingerIndex,
    createEmployee: input.createEmployee === true, name: input.createEmployee ? input.name.trim() : '' };
}

async function readEnrollmentSnapshot(device) {
  if (device.connectionType !== 'tcp') throw enrollmentError('El registro remoto requiere conexion TCP.', 422);
  const model = String(await device.getDeviceName()).replace(/\0/g, '').trim();
  if (!/^F22(?:\/ID|ID)?$/i.test(model)) throw enrollmentError('El registro remoto solo esta habilitado para F22/F22ID.', 422);
  const tcp = device.zklibTcp;
  const counts = await tcp.executeCmd(C.CMD_GET_FREE_SIZES, Buffer.alloc(0));
  assert.ok(counts.length >= 36 && counts.readUInt16LE(0) === C.CMD_ACK_OK, 'No se pudieron verificar los contadores del reloj.');
  const userCount = counts.readUInt32LE(24);
  const fingerCount = counts.readUInt32LE(32);
  await tcp.freeData();
  const userData = await readTcpPreparedData(tcp, REQUEST_DATA.GET_USERS);
  const users = [];
  let usersHash;
  const userHashes = new Map();
  try {
    const buffer = validateRecordBuffer(userData, 72);
    for (let offset = 0; offset < buffer.length; offset += 72) {
      const user = decodeUserData72(buffer.subarray(offset, offset + 72));
      userHashes.set(user.uid, crypto.createHash('sha256').update(buffer.subarray(offset, offset + 72)).digest('hex'));
      users.push({ uid: user.uid, employeeId: String(user.userId), name: user.name, role: user.role, cardNo: user.cardno });
    }
    usersHash = crypto.createHash('sha256').update(userData).digest('hex');
  } finally { userData.fill(0); }
  assert.equal(users.length, userCount, 'Listado de empleados incompleto.');
  await tcp.freeData();
  const request = Buffer.alloc(11);
  request[0] = 1;
  request.writeUInt16LE(7, 1);
  request.writeUInt32LE(2, 3);
  const data = await readTcpPreparedData(tcp, request);
  const templates = new Map();
  try {
    assert.ok(data.length === 0 || (data.length >= 4 && data.readUInt32LE(0) === data.length - 4), 'Historial de huellas incompleto.');
    for (let offset = 4; offset < data.length;) {
      assert.ok(offset + 6 <= data.length, 'Cabecera de huella incompleta.');
      const size = data.readUInt16LE(offset);
      assert.ok(size >= 6 && offset + size <= data.length, 'Huella incompleta.');
      const key = `${data.readUInt16LE(offset + 2)}:${data[offset + 4]}`;
      assert.ok(!templates.has(key), 'Posicion de huella duplicada.');
      templates.set(key, crypto.createHash('sha256').update(data.subarray(offset, offset + size)).digest('hex'));
      offset += size;
    }
  } finally { data.fill(0); }
  assert.equal(templates.size, fingerCount, 'Listado de huellas incompleto.');
  await tcp.freeData();
  // Only transient hashes stay in RAM for integrity checks; never return them to clients.
  return { users, usersHash, userHashes, templates };
}

function commandChannel(tcp) {
  let buffer = Buffer.alloc(0);
  let failure;
  const pending = new Map();
  function fail(error) {
    failure = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  const close = () => fail(new Error('Conexion cerrada durante el registro.'));
  function data(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const size = buffer.readUInt32LE(4);
      if (buffer.readUInt32LE(0) !== 0x7d825050 || size < 8 || size > 1048576) return fail(new Error('Respuesta de registro invalida.'));
      if (buffer.length < size + 8) return;
      const frame = buffer.subarray(0, size + 8);
      buffer = buffer.subarray(size + 8);
      if (frame.readUInt16LE(8) === C.CMD_REG_EVENT) {
        tcp.socket.write(createTCPHeader(C.CMD_ACK_OK, tcp.sessionId, 65534, Buffer.alloc(0)));
        continue;
      }
      const id = frame.readUInt16LE(14);
      const request = pending.get(id);
      if (request) {
        pending.delete(id);
        clearTimeout(request.timer);
        request.resolve({ code: frame.readUInt16LE(8), payload: frame.subarray(16) });
      }
    }
  }
  tcp.socket.on('data', data);
  tcp.socket.on('error', fail);
  tcp.socket.on('close', close);
  return {
    send(command, payload = Buffer.alloc(0)) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        tcp.replyId++;
        const packet = createTCPHeader(command, tcp.sessionId, tcp.replyId, payload);
        const id = packet.readUInt16LE(14);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('El equipo no respondio durante el registro.')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        tcp.socket.write(packet, error => {
          if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      });
    },
    close() {
      tcp.socket.removeListener('data', data);
      tcp.socket.removeListener('error', fail);
      tcp.socket.removeListener('close', close);
      fail(new Error('Registro finalizado.'));
    },
  };
}

async function captureFingerprint(device, input, control, options = {}) {
  const read = options.read || readEnrollmentSnapshot;
  const open = options.open || commandChannel;
  const sleep = options.sleep || delay;
  const now = options.now || Date.now;
  const duration = options.duration || 90000;
  const report = control.report;
  let createdEmployee = false;
  let initial = await read(device);
  control.signal.throwIfAborted();
  let user = initial.users.find(item => item.employeeId === input.employeeId);
  if (input.createEmployee) {
    if (user) throw enrollmentError('El ID ya existe en este biometrico. Seleccione el empleado existente.');
    const uid = Math.max(0, ...initial.users.map(item => item.uid)) + 1;
    if (uid > 3000) throw enrollmentError('No hay un UID libre compatible para crear el empleado.');
    const payload = Buffer.alloc(72);
    payload.writeUInt16LE(uid, 0);
    payload.write(input.name, 11, 24, 'utf8');
    payload.write(input.employeeId, 48, 24, 'ascii');
    const reply = await device.zklibTcp.executeCmd(C.CMD_USER_WRQ, payload);
    if (reply.readUInt16LE(0) !== C.CMD_ACK_OK) throw enrollmentError('El reloj rechazo la creacion del empleado.');
    createdEmployee = true;
    report({ employeeCreated: true });
    const fresh = await read(device);
    user = fresh.users.find(item => item.employeeId === input.employeeId);
    if (!user || user.uid !== uid || user.name !== input.name || user.role !== 0) throw enrollmentError('No se pudo verificar el empleado creado.');
    if (fresh.users.length !== initial.users.length + 1 || [...initial.userHashes].some(([uid, hash]) => fresh.userHashes.get(uid) !== hash)) {
      throw enrollmentError('Se detectaron cambios inesperados en los empleados.');
    }
    if (fresh.templates.size !== initial.templates.size || [...initial.templates].some(([key, hash]) => fresh.templates.get(key) !== hash)) {
      throw enrollmentError('Se detectaron cambios inesperados en las huellas existentes.');
    }
    initial = fresh;
  } else if (!user) {
    throw enrollmentError('El empleado no existe en este reloj. Sincronice o seleccione Nuevo empleado.', 404);
  }
  if (options.saveEmployees) options.saveEmployees(initial.users);
  control.signal.throwIfAborted();
  const key = `${user.uid}:${input.fingerIndex}`;
  if (initial.templates.has(key)) throw enrollmentError('Ese dedo ya tiene una huella guardada. No se reemplazara.');
  const channel = open(device.zklibTcp);
  let entered = false;
  let restored = true;
  let failure;
  try {
    if ((await channel.send(C.CMD_CANCELCAPTURE)).code !== C.CMD_ACK_OK) throw enrollmentError('No se pudo preparar la captura.');
    control.signal.throwIfAborted();
    const payload = Buffer.alloc(26);
    payload.write(input.employeeId, 0, 24, 'ascii');
    payload[24] = input.fingerIndex;
    payload[25] = 1;
    entered = true;
    if ((await channel.send(C.CMD_STARTENROLL, payload)).code !== C.CMD_ACK_OK) throw enrollmentError('El reloj rechazo el inicio del registro.');
    const deadline = now() + duration;
    report({ status: 'waiting', message: 'Esperando captura en el biometrico.', deadline: new Date(deadline).toISOString() });
    while (now() < deadline) {
      await sleep(2000, undefined, { signal: control.signal });
      control.signal.throwIfAborted();
      const info = await channel.send(C.CMD_GET_FREE_SIZES);
      if (info.code === C.CMD_ACK_OK && info.payload.length >= 28 && info.payload.readUInt32LE(24) > initial.templates.size) break;
    }
  } catch (error) { failure = error; }
  finally {
    if (entered) {
      for (const command of [C.CMD_CANCELCAPTURE, C.CMD_STARTVERIFY]) {
        let accepted = false;
        for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
          try { accepted = (await channel.send(command)).code === C.CMD_ACK_OK; } catch {}
        }
        if (!accepted) restored = false;
      }
    }
    channel.close();
  }
  report({ status: 'verifying', message: 'Verificando almacenamiento y estado del reloj.' });
  let after;
  try { after = await read(device); }
  catch (error) {
    return { status: 'needs_attention', message: 'No se pudo comprobar el resultado. Revise el reloj antes de reintentar.', employeeCreated: createdEmployee, normalModeRestored: restored };
  }
  const stored = after.templates.has(key);
  const intact = initial.usersHash === after.usersHash && [...initial.templates].every(([slot, hash]) => after.templates.get(slot) === hash)
    && [...after.templates.keys()].every(slot => initial.templates.has(slot) || slot === key);
  if (!intact || !restored) return { status: 'needs_attention', message: 'El registro requiere revision del administrador en el reloj.', fingerprintStored: stored, employeeCreated: createdEmployee, normalModeRestored: restored };
  if (stored) return { status: 'completed', message: 'Huella registrada y verificada.', fingerprintStored: true, employeeCreated: createdEmployee, normalModeRestored: true };
  if (control.signal.aborted) return { status: 'cancelled', message: 'Registro cancelado. No se guardo una huella nueva.', employeeCreated: createdEmployee, normalModeRestored: true };
  if (failure) throw failure;
  return { status: 'timeout', message: 'Tiempo agotado. No se encontro una huella nueva guardada.', employeeCreated: createdEmployee, normalModeRestored: true };
}

module.exports = { enrollmentError, validateEnrollment, readEnrollmentSnapshot, commandChannel, captureFingerprint };
