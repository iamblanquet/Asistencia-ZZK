const crypto = require('node:crypto');
const { enrollmentError, readEnrollmentSnapshot } = require('./zkEnrollment');
const { archiveIndex } = require('./biometricArchive');
const { prepareUserRestore, uploadTemplatePacket } = require('./biometricRestoreTest');

const sameMap = (a, b) => a.size === b.size && [...a].every(([key, hash]) => b.get(key) === hash);
function revision(snapshot) {
  if (snapshot.userHashes.size !== snapshot.users.length || new Set(snapshot.users.map(user => user.employeeId)).size !== snapshot.users.length) {
    throw enrollmentError('El listado del reloj contiene identidades duplicadas o incompletas. No se realizaran cambios.');
  }
  return crypto.createHash('sha256').update(JSON.stringify({ users: [...snapshot.userHashes].sort((a, b) => a[0] - b[0]),
    templates: [...snapshot.templates].sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
}

async function identify(connected, config, payload) {
  const clean = value => String(value).replace(/\0/g, '').trim();
  const serial = clean(await connected.getSerialNumber());
  const model = clean(await connected.getDeviceName());
  const firmware = clean(await connected.getFirmware());
  if (connected.connectionType !== 'tcp' || !/^F22(?:\/ID|ID)?$/i.test(model)) throw enrollmentError('Los respaldos de huellas requieren un F22/F22ID por TCP.', 422);
  if (payload && (payload.device.id !== config.id || payload.device.serial !== serial || payload.device.model !== model || payload.device.firmware !== firmware)) {
    throw enrollmentError('El respaldo no corresponde a este biometrico, serie y firmware. No se permite copiar huellas entre equipos.', 409);
  }
  return { id: config.id, name: config.name, ip: config.ip, serial, model, firmware };
}

function candidates(snapshot, index) {
  return index.employees.map(employee => {
    let reason = '';
    if (employee.role !== 0) reason = 'Usuario con privilegios protegido';
    else if (!/^[1-9]\d{0,8}$/.test(employee.employeeId)) reason = 'ID no compatible con recuperacion';
    else if (!employee.fingers.length || !employee.valid) reason = 'Sin plantillas validas para recuperar';
    else if (new Set(employee.fingers).size !== employee.fingers.length) reason = 'Varias plantillas para un mismo dedo; restauracion requiere revision';
    else if (snapshot.users.some(user => user.employeeId === employee.employeeId)) reason = 'Ya existe en el reloj';
    else if (snapshot.users.some(user => user.uid === employee.uid)) reason = 'UID original ocupado por otro usuario';
    else if ([...snapshot.templates.keys()].some(key => key.startsWith(`${employee.uid}:`))) reason = 'Huellas residuales; requiere revision';
    return { employeeId: employee.employeeId, name: employee.name, fingerprintCount: employee.fingers.length,
      fingers: employee.fingers, eligible: !reason, reason };
  }).sort((a, b) => a.employeeId.localeCompare(b.employeeId, 'en', { numeric: true }));
}

async function previewRecovery(connected, config, payload, options = {}) {
  const device = await identify(connected, config, payload);
  const snapshot = await (options.read || readEnrollmentSnapshot)(connected);
  const index = archiveIndex(payload);
  return { device, employees: candidates(snapshot, index), revision: revision(snapshot) };
}

async function restoreArchivedUser(connected, config, payload, employeeId, control, options = {}) {
  await identify(connected, config, payload);
  const read = options.read || readEnrollmentSnapshot;
  const index = archiveIndex(payload);
  const before = await read(connected);
  if (revision(before) !== control.revision) throw enrollmentError('El reloj cambio desde la vista previa. Vuelva a consultar antes de restaurar.');
  const candidate = candidates(before, index).find(item => item.employeeId === employeeId);
  if (!candidate?.eligible) throw enrollmentError(candidate?.reason || 'El usuario no existe en este respaldo.');
  const prepared = prepareUserRestore(payload, { employeeId });
  try {
    control.beforeWrite();
    const transfer = await uploadTemplatePacket(connected.zklibTcp, prepared.packet, { open: options.open,
      beforeCommit: () => { control.beforeWrite(); control.writeAttempted(); } });
    let after;
    try { after = await read(connected); }
    catch { throw enrollmentError('La carga fue enviada, pero no se pudo verificar. Revise el reloj antes de reintentar.', 503); }
    const expectedUsers = new Map(before.userHashes);
    expectedUsers.set(prepared.target.uid, index.userHashes.get(prepared.target.uid));
    const expectedTemplates = new Map(before.templates);
    for (const [key, hash] of index.templates) if (key.startsWith(`${prepared.target.uid}:`)) expectedTemplates.set(key, hash);
    if (!transfer.saveAccepted || transfer.transferFailure || !sameMap(after.userHashes, expectedUsers) ||
        after.users.length !== before.users.length + 1 || !sameMap(after.templates, expectedTemplates)) {
      throw enrollmentError('No se pudo verificar la recuperacion completa. Revise el reloj antes de reintentar.', 503);
    }
    return { users: after.users, employee: { employeeId, name: candidate.name }, fingerprintCount: candidate.fingerprintCount };
  } finally { prepared.packet.fill(0); }
}

module.exports = { identify, revision, candidates, previewRecovery, restoreArchivedUser };
