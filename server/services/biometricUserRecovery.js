const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readEnrollmentSnapshot } = require('./zkEnrollment');
const { prepareIdenticalRestore, uploadTemplatePacket } = require('./biometricRestoreTest');

function sameMap(left, right) {
  return left.size === right.size && [...left].every(([key, hash]) => right.get(key) === hash);
}

function backupUserRecords(payload, targetId) {
  const data = Buffer.from(payload.records.users, 'base64');
  const hashes = new Map();
  let name;
  try {
    for (let offset = 4; offset < data.length; offset += 72) {
      const record = data.subarray(offset, offset + 72);
      hashes.set(record.readUInt16LE(0), crypto.createHash('sha256').update(record).digest('hex'));
      if (record.subarray(48).toString('utf8').split('\0')[0] === targetId) name = record.subarray(11, 35).toString('utf8').split('\0')[0];
    }
    assert.ok(name !== undefined, 'El usuario solicitado no existe en este respaldo.');
    return { hashes, name };
  } finally { data.fill(0); }
}

function recoveryState(snapshot, prepared, expectedUsers) {
  const { target, expectedTemplates } = prepared;
  assert.ok(new Set(snapshot.users.map(user => user.uid)).size === snapshot.users.length &&
    new Set(snapshot.users.map(user => user.employeeId)).size === snapshot.users.length && snapshot.userHashes.size === snapshot.users.length,
  'El listado actual contiene identidades duplicadas.');
  const existing = snapshot.users.find(user => user.employeeId === target.employeeId);
  if (existing) {
    assert.ok(existing.uid === target.uid && sameMap(snapshot.userHashes, expectedUsers) && sameMap(snapshot.templates, expectedTemplates), 'El usuario u otros datos cambiaron desde el respaldo. No se reemplazaran.');
    return 'present';
  }
  assert.ok(!snapshot.users.some(user => user.uid === target.uid), 'El UID original esta ocupado por otro usuario. No se sobrescribira.');
  const otherUsers = new Map([...expectedUsers].filter(([uid]) => uid !== target.uid));
  const otherTemplates = new Map([...expectedTemplates].filter(([key]) => !key.startsWith(`${target.uid}:`)));
  assert.ok(sameMap(snapshot.userHashes, otherUsers) && sameMap(snapshot.templates, otherTemplates), 'Hay otros cambios o huellas residuales. Solo se permite recuperar el usuario seleccionado sin modificar los demas.');
  return 'missing';
}

async function recoverDeletedUser(device, payload, selection, options = {}) {
  assert.ok(/^[1-9]\d{0,8}$/.test(selection?.employeeId || ''), 'Seleccione un ID canonico explicitamente.');
  const prepared = prepareIdenticalRestore(payload, { employeeId: selection.employeeId });
  const read = options.read || readEnrollmentSnapshot;
  try {
    const { hashes: expectedUsers, name } = backupUserRecords(payload, selection.employeeId);
    const serial = String(await device.getSerialNumber()).replace(/\0/g, '').trim();
    const model = String(await device.getDeviceName()).replace(/\0/g, '').trim();
    const firmware = String(await device.getFirmware()).replace(/\0/g, '').trim();
    assert.ok(device.connectionType === 'tcp' && /^F22(?:\/ID|ID)?$/i.test(model), 'La recuperacion requiere F22/F22ID por TCP.');
    assert.ok(serial === payload.device.serial && model === payload.device.model && firmware === payload.device.firmware, 'Serie, modelo o firmware diferentes al respaldo.');
    assert.equal(selection.expectedName, name, 'El nombre confirmado no coincide con el respaldo.');
    const before = await read(device);
    const state = recoveryState(before, prepared, expectedUsers);
    const base = { device: { serial, model, firmware, ip: payload.device.ip }, target: { ...prepared.target, name },
      usersBefore: before.users.length, fingerprintsBefore: before.templates.size,
      expectedUsersAfter: expectedUsers.size, expectedFingerprintsAfter: prepared.expectedTemplates.size,
      testType: 'recover-one-deleted-user', physicalRecognitionTested: false, checkedAt: new Date().toISOString() };
    if (options.execute !== true) return { ...base, status: state === 'present' ? 'waiting_for_deletion' : 'ready_to_restore', writeAttempted: false };
    assert.equal(selection.confirmed, true, 'Confirme explicitamente la recuperacion.');
    assert.equal(state, 'missing', 'El usuario sigue presente. Esta herramienta nunca lo elimina ni sobrescribe.');
    await options.beforeWrite?.();
    assert.equal(recoveryState(await read(device), prepared, expectedUsers), 'missing', 'El usuario fue recreado durante la preparacion.');
    const transfer = await uploadTemplatePacket(device.zklibTcp, prepared.packet, { ...options, beforeCommit: options.beforeWrite });
    let after;
    try { after = await read(device); }
    catch { return { ...base, ...transfer, status: 'needs_attention', verified: false, reason: 'No se pudo verificar el resultado; no reintente la escritura automaticamente.' }; }
    const recovered = sameMap(after.userHashes, expectedUsers) && after.users.length === expectedUsers.size && sameMap(after.templates, prepared.expectedTemplates);
    const unchanged = sameMap(after.userHashes, before.userHashes) && after.users.length === before.users.length && sameMap(after.templates, before.templates);
    const verified = recovered && transfer.saveAccepted && !transfer.transferFailure;
    return { ...base, ...transfer, status: verified ? 'verified_user_recovery' : unchanged ? 'rejected_unchanged' : 'needs_attention',
      verified, recoveredUserAndFingerprintVerified: recovered, otherUsersAndFingerprintsUnchanged: recovered || unchanged,
      deletionRecoveryTested: verified, usersAfter: after.users.length, fingerprintsAfter: after.templates.size };
  } finally { prepared.packet.fill(0); }
}

module.exports = { recoverDeletedUser };
