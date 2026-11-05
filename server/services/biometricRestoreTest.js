const assert = require('node:assert/strict');
const { COMMANDS: C } = require('zklib-js/constants');
const { readEnrollmentSnapshot, commandChannel } = require('./zkEnrollment');
const { inspectRecords, validateBackup } = require('./biometricBackup');

function sameTemplates(left, right) {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

async function uploadTemplatePacket(tcp, packet, options = {}) {
  const channel = (options.open || commandChannel)(tcp);
  const acknowledgements = [];
  let writeAttempted = false;
  let saveAccepted = false;
  let transferFailure = false;
  async function send(command, data = Buffer.alloc(0)) {
    const reply = await channel.send(command, data);
    acknowledgements.push({ command, code: reply.code });
    assert.equal(reply.code, C.CMD_ACK_OK, 'El reloj rechazo un comando de carga.');
  }
  try {
    await send(C.CMD_FREE_DATA);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(packet.length);
    await send(C.CMD_PREPARE_DATA, size);
    for (let offset = 0; offset < packet.length; offset += 1024) await send(C.CMD_DATA, packet.subarray(offset, offset + 1024));
    const commit = Buffer.alloc(8);
    commit.writeUInt32LE(12, 0);
    commit.writeUInt16LE(8, 6);
    await options.beforeCommit?.();
    writeAttempted = true;
    await send(110, commit);
    saveAccepted = true;
    await send(C.CMD_REFRESHDATA);
  } catch { transferFailure = true; }
  finally {
    try { await send(C.CMD_FREE_DATA); } catch { transferFailure = true; }
    channel.close();
  }
  return { writeAttempted, saveAccepted, transferFailure, acknowledgements };
}

function prepareUserRestore(payload, selection = {}, single = false) {
  validateBackup(payload);
  const users = Buffer.from(payload.records.users, 'base64');
  const templates = Buffer.from(payload.records.templates, 'base64');
  try {
    const records = inspectRecords(users, templates);
    const candidates = [];
    for (let offset = 4; offset < users.length; offset += 72) {
      const record = users.subarray(offset, offset + 72);
      const uid = record.readUInt16LE(0);
      const employeeId = record.subarray(48, 72).toString('utf8').split('\0')[0];
      const fingers = [];
      for (let start = 4; start < templates.length;) {
        const size = templates.readUInt16LE(start);
        if (templates.readUInt16LE(start + 2) === uid) fingers.push({ start, size, fingerIndex: templates[start + 4], valid: templates[start + 5] });
        start += size;
      }
      if (record[2] !== 0 || !fingers.length || fingers.some(finger => finger.valid !== 1) || (single && fingers.length !== 1)) continue;
      const finger = fingers[0];
      if (selection.employeeId !== undefined && selection.employeeId !== employeeId) continue;
      if (selection.fingerIndex !== undefined && selection.fingerIndex !== finger.fingerIndex) continue;
      candidates.push({ record, uid, employeeId, finger, fingers });
    }
    candidates.sort((a, b) => a.employeeId.localeCompare(b.employeeId, 'en', { numeric: true }));
    assert.ok(candidates.length, 'No hay un usuario normal con una sola huella valida para esta prueba.');
    const { record, uid, employeeId, finger, fingers } = candidates[0];
    assert.equal(new Set(fingers.map(item => item.fingerIndex)).size, fingers.length,
      'Este usuario tiene varias plantillas para un mismo dedo. La restauracion requiere revision; no se enviara ninguna carga.');
    // pyzk HR_save_usertemplates format. Preserve every original user byte,
    // including credentials and access fields, instead of rebuilding defaults.
    const userPack = Buffer.concat([Buffer.from([2]), record]);
    const table = Buffer.alloc(8 * fingers.length);
    const fingerParts = [];
    let position = 0;
    for (const [index, item] of fingers.entries()) {
      table[index * 8] = 2;
      table.writeUInt16LE(uid, index * 8 + 1);
      table[index * 8 + 3] = 0x10 + item.fingerIndex;
      table.writeUInt32LE(position, index * 8 + 4);
      const template = templates.subarray(item.start + 6, item.start + item.size);
      const part = Buffer.alloc(2 + template.length);
      part.writeUInt16LE(template.length);
      template.copy(part, 2);
      fingerParts.push(part);
      position += part.length;
    }
    const fingerPack = Buffer.concat(fingerParts);
    fingerParts.forEach(part => part.fill(0));
    const head = Buffer.alloc(12);
    head.writeUInt32LE(userPack.length, 0);
    head.writeUInt32LE(table.length, 4);
    head.writeUInt32LE(fingerPack.length, 8);
    const packet = Buffer.concat([head, userPack, table, fingerPack]);
    userPack.fill(0);
    fingerPack.fill(0);
    return { packet, target: { uid, employeeId, fingerIndex: finger.fingerIndex,
      ...(!single && { fingerIndices: fingers.map(item => item.fingerIndex) }) }, expectedTemplates: records.templates,
      expectedUsersHash: records.manifest.usersSha256, expectedUsersCount: records.manifest.usersCount };
  } finally { users.fill(0); templates.fill(0); }
}

function prepareIdenticalRestore(payload, selection = {}) { return prepareUserRestore(payload, selection, true); }

async function testIdenticalRestore(device, payload, selection, options = {}) {
  const read = options.read || readEnrollmentSnapshot;
  const serial = String(await device.getSerialNumber()).replace(/\0/g, '').trim();
  const model = String(await device.getDeviceName()).replace(/\0/g, '').trim();
  const firmware = String(await device.getFirmware()).replace(/\0/g, '').trim();
  assert.ok(device.connectionType === 'tcp' && /^F22(?:\/ID|ID)?$/i.test(model), 'La prueba requiere F22/F22ID por TCP.');
  assert.ok(serial === payload.device.serial && model === payload.device.model && firmware === payload.device.firmware, 'La identidad o el firmware del reloj no coincide con el respaldo.');
  const prepared = prepareIdenticalRestore(payload, selection);
  const { target } = prepared;
  try {
    const before = await read(device);
    assert.ok(before.usersHash === prepared.expectedUsersHash && before.users.length === prepared.expectedUsersCount && sameTemplates(before.templates, prepared.expectedTemplates), 'El reloj cambio desde el respaldo; esta prueba no reemplaza datos diferentes ni restaura usuarios ausentes.');
    const base = { device: { serial, model, firmware, ip: payload.device.ip }, target,
      users: before.users.length, fingerprints: before.templates.size, testType: 'identical-existing-user-and-fingerprint',
      deletionRecoveryTested: false, physicalRecognitionTested: false };
    if (options.execute !== true) return { status: 'ready', ...base, writeAttempted: false };
    assert.ok(selection?.employeeId === target.employeeId && selection?.fingerIndex === target.fingerIndex, 'La escritura requiere un usuario y dedo seleccionados explicitamente.');
    await options.beforeWrite?.();
    const { writeAttempted, saveAccepted, transferFailure, acknowledgements } = await uploadTemplatePacket(device.zklibTcp, prepared.packet, options);
    const result = { ...base, writeAttempted, saveAccepted, acknowledgements, checkedAt: new Date().toISOString() };
    let after;
    try { after = await read(device); }
    catch { return { ...result, status: 'needs_attention', verified: false, reason: 'No se pudo leer el reloj despues de la carga.' }; }
    const unchanged = before.usersHash === after.usersHash && before.users.length === after.users.length && sameTemplates(before.templates, after.templates);
    return { ...result, status: !unchanged ? 'needs_attention' : transferFailure || !saveAccepted ? 'rejected_unchanged' : 'verified_identical_write',
      verified: unchanged && saveAccepted && !transferFailure, allUsersAndFingerprintsUnchanged: unchanged,
      usersAfter: after.users.length, fingerprintsAfter: after.templates.size };
  } finally { prepared.packet.fill(0); }
}

module.exports = { prepareIdenticalRestore, prepareUserRestore, testIdenticalRestore, uploadTemplatePacket };
