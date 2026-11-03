const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { COMMANDS: C, REQUEST_DATA } = require('zklib-js/constants');
const { decodeUserData72 } = require('zklib-js/utils');
const { readTcpPreparedData, validateRecordBuffer } = require('./zkTcpDownload');
const { enrollmentError, readEnrollmentSnapshot } = require('./zkEnrollment');

function validEmployeeId(value) {
  if (!/^[1-9]\d{0,8}$/.test(String(value || ''))) throw enrollmentError('ID de empleado invalido.', 400);
  return String(value);
}
function validName(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > 24 || /[\x00-\x1f\x7f]/.test(value)) {
    throw enrollmentError('El nombre debe ocupar entre 1 y 24 bytes UTF-8 y no contener caracteres de control.', 400);
  }
  return value.trim();
}
function fingerprintRevision(snapshot, uid) {
  return crypto.createHash('sha256').update(JSON.stringify([...snapshot.templates].filter(([key]) => key.startsWith(`${uid}:`)).sort())).digest('hex');
}
function previewUser(snapshot, employeeId) {
  const user = snapshot.users.find(user => user.employeeId === employeeId);
  if (!user) throw enrollmentError('El usuario no existe en el biometrico. El historial de ASISTO se conserva.', 404);
  return { user, userHash: snapshot.userHashes.get(user.uid), fingerprintRevision: fingerprintRevision(snapshot, user.uid),
    fingerprintCount: [...snapshot.templates.keys()].filter(key => key.startsWith(`${user.uid}:`)).length };
}
async function readUserRecord(device, user, expectedHash) {
  const tcp = device.zklibTcp;
  await tcp.freeData();
  const raw = await readTcpPreparedData(tcp, REQUEST_DATA.GET_USERS);
  try {
    const users = validateRecordBuffer(raw, 72);
    for (let offset = 0; offset < users.length; offset += 72) {
      const record = users.subarray(offset, offset + 72);
      const decoded = decodeUserData72(record);
      if (decoded.uid === user.uid && String(decoded.userId) === user.employeeId) {
        if (crypto.createHash('sha256').update(record).digest('hex') !== expectedHash) throw enrollmentError('El usuario cambio en el reloj. Consulte de nuevo antes de editar.');
        return Buffer.from(record);
      }
    }
    throw enrollmentError('El usuario cambio en el reloj. Consulte de nuevo antes de editar.');
  } finally { raw.fill(0); await tcp.freeData(); }
}

async function mutateDeviceUser(device, action, employeeId, input, control, options = {}) {
  const read = options.read || readEnrollmentSnapshot;
  const before = await read(device);
  const target = previewUser(before, employeeId);
  if (target.user.uid !== control.revision.uid || target.userHash !== control.revision.userHash ||
      target.fingerprintRevision !== control.revision.fingerprintRevision) throw enrollmentError('El usuario o sus huellas cambiaron. Vuelva a consultar y confirmar.');
  if (action === 'delete' && target.user.role !== 0) throw enrollmentError('No se permite eliminar administradores ni usuarios con privilegios desde ASISTO.', 403);
  let expectedUserHash;
  let payload;
  try {
    if (action === 'rename') {
      payload = await (options.readRecord || readUserRecord)(device, target.user, target.userHash);
      payload.fill(0, 11, 35);
      payload.write(input.name, 11, 24, 'utf8');
      expectedUserHash = crypto.createHash('sha256').update(payload).digest('hex');
    } else {
      payload = Buffer.alloc(2);
      payload.writeUInt16LE(target.user.uid);
    }
    control.beforeWrite();
    control.writeAttempted();
    const reply = await device.zklibTcp.executeCmd(action === 'rename' ? C.CMD_USER_WRQ : C.CMD_DELETE_USER, payload);
    if (!reply || reply.length < 8 || reply.readUInt16LE(0) !== C.CMD_ACK_OK) throw enrollmentError('El biometrico rechazo la operacion.');
  } finally { payload?.fill(0); }
  if (action === 'delete') {
    const reply = await device.zklibTcp.executeCmd(C.CMD_REFRESHDATA || 1013, Buffer.alloc(0));
    if (!reply || reply.readUInt16LE(0) !== C.CMD_ACK_OK) throw enrollmentError('No se pudo confirmar la actualizacion de usuarios del reloj.');
  }
  const after = await read(device);
  const current = after.users.find(user => user.employeeId === employeeId);
  const remainingUsers = before.users.filter(user => user.uid !== target.user.uid);
  assert.ok(remainingUsers.every(user => after.userHashes.get(user.uid) === before.userHashes.get(user.uid)), 'Cambio inesperado en otros usuarios.');
  if (action === 'rename') {
    assert.ok(current && current.uid === target.user.uid && current.name === input.name, 'El nombre no quedo guardado como se solicito.');
    assert.equal(after.users.length, before.users.length, 'El numero de usuarios cambio inesperadamente.');
    assert.equal(after.userHashes.get(target.user.uid), expectedUserHash, 'Cambiaron otros campos del usuario.');
    assert.ok(after.templates.size === before.templates.size && [...before.templates].every(([key, hash]) => after.templates.get(key) === hash), 'Cambiaron huellas durante la edicion del nombre.');
  } else {
    assert.ok(!current && !after.users.some(user => user.uid === target.user.uid), 'El usuario sigue presente en el reloj.');
    assert.equal(after.users.length, before.users.length - 1, 'El numero de usuarios no coincide tras la eliminacion.');
    const remaining = [...before.templates].filter(([key]) => !key.startsWith(`${target.user.uid}:`));
    assert.ok(after.templates.size === remaining.length && remaining.every(([key, hash]) => after.templates.get(key) === hash), 'No se pudo verificar la eliminacion de huellas del usuario.');
  }
  return { users: after.users, employee: current || target.user, previousName: target.user.name,
    removedFingerprints: action === 'delete' ? target.fingerprintCount : 0 };
}

module.exports = { validEmployeeId, validName, previewUser, mutateDeviceUser, readUserRecord };
