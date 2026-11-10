const { test, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-device-names-'));
process.env.ASISTENCIA_DATA_DIR = directory;
process.env.INITIAL_ADMIN_PASSWORD = 'Device-Name-Fixture-2026';
const { db } = require('./services/sqlite');
const { addDevice, saveEmployees, getEmployees, updateEmployeeName } = require('./services/db');
const { addStoredEvents, getStoredEvents } = require('./services/eventStore');
const ZKLib = require('zklib-js');
let userCount = 1;
let users = [{ userId: '1', uid: 44, name: 'Sebastian' }];
mock.method(ZKLib.prototype, 'createSocket', async function () { this.connectionType = 'udp'; });
mock.method(ZKLib.prototype, 'disconnect', async () => {});
mock.method(ZKLib.prototype, 'getInfo', async () => ({ userCounts: userCount, logCounts: 1 }));
mock.method(ZKLib.prototype, 'getUsers', async () => ({ data: users }));
mock.method(ZKLib.prototype, 'getAttendances', async () => { throw new Error('Name-only reads must not download attendance'); });
for (const name of ['setUser', 'deleteUser', 'setTime', 'disableDevice', 'enableDevice']) {
  if (typeof ZKLib.prototype[name] === 'function') mock.method(ZKLib.prototype, name, async () => { throw new Error('A name read must never write to the clock'); });
}
const { downloadEmployeeSnapshot } = require('./services/zkteco');
const current = addDevice({ name: 'Clock names', ip: '127.0.0.1', namesFromDevice: true });
const other = addDevice({ name: 'Local aliases', ip: '127.0.0.2' });
for (const device of [current, other]) {
  saveEmployees(device.id, [{ employeeId: '1', uid: '44', name: 'Old name' }]);
  db.prepare('UPDATE employees SET override_name=? WHERE device_id=?').run('Old alias', device.id);
  addStoredEvents(device.id, [{ employeeId: '1', deviceUserId: '1', uid: '619', timestamp: '2026-11-10T14:21:54Z' }], 'device');
}
const rawEvents = id => db.prepare('SELECT * FROM events WHERE device_id=? ORDER BY timestamp').all(id);

after(() => {
  mock.restoreAll();
  db.close();
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('asisto-device-names-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('a name-only read uses the explicit device ID and ignores stale aliases without writing SQL or clock data', async () => {
  const before = rawEvents(current.id);
  const snapshot = await downloadEmployeeSnapshot(current);
  assert.equal(snapshot.employees[0].employeeId, '1');
  assert.equal(snapshot.employees[0].name, 'Sebastian');
  assert.equal(getEmployees(current.id)[0].name, 'Old alias');
  assert.deepEqual(rawEvents(current.id), before);
});

test('saving the verified roster updates display and report names but keeps every attendance field unchanged', async () => {
  const before = rawEvents(current.id);
  const otherBefore = rawEvents(other.id);
  const snapshot = await downloadEmployeeSnapshot(current);
  saveEmployees(current.id, snapshot.employees);
  assert.equal(getEmployees(current.id)[0].name, 'Sebastian');
  assert.equal(getStoredEvents(current.id)[0].employeeName, 'Sebastian');
  assert.equal(db.prepare('SELECT override_name FROM employees WHERE device_id=?').get(current.id).override_name, null);
  assert.equal(getEmployees(other.id)[0].name, 'Old alias');
  assert.deepEqual(rawEvents(current.id), before);
  assert.deepEqual(rawEvents(other.id), otherBefore);
  assert.throws(() => updateEmployeeName(current.id, '1', 'Old alias again'), error => error.statusCode === 409);
});

test('future name changes keep following the clock while other biometrics retain their aliases', async () => {
  const before = rawEvents(current.id);
  users = [{ userId: '1', uid: 44, name: 'Sebastian updated', nameUtf8: 'Sebasti\u00e1n actualizado' }];
  try {
    const snapshot = await downloadEmployeeSnapshot(current);
    saveEmployees(current.id, snapshot.employees);
    assert.equal(getEmployees(current.id)[0].name, 'Sebasti\u00e1n actualizado');
    assert.equal((await downloadEmployeeSnapshot(other)).employees[0].name, 'Old alias');
    assert.deepEqual(rawEvents(current.id), before);
  } finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
});

test('partial or duplicate rosters cannot update names', async () => {
  const before = getEmployees(current.id);
  userCount = 2;
  try { await assert.rejects(downloadEmployeeSnapshot(current), /padron completo/); }
  finally { userCount = 1; }
  users = [{ userId: '1', uid: 44, name: 'One' }, { userId: '1', uid: 45, name: 'Duplicate' }];
  userCount = 2;
  try { await assert.rejects(downloadEmployeeSnapshot(current), /padron completo/); }
  finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; userCount = 1; }
  users = [{ uid: 44, name: 'UID without ID' }];
  try { await assert.rejects(downloadEmployeeSnapshot(current), /ID explicito/); }
  finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
  users = [{ userId: '1', uid: 44, nameUtf8: 'Invalid \ufffd' }];
  try { await assert.rejects(downloadEmployeeSnapshot(current), /codificacion/); }
  finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
  assert.deepEqual(getEmployees(current.id), before);
});

test('legacy Latin-1 names keep their accents without affecting IDs or attendance', async () => {
  const device = addDevice({ name: 'Latin-1 clock', ip: '127.0.0.3', namesFromDevice: true, nameEncoding: 'latin1' });
  users = [{ userId: '68', uid: 7, name: 'Josi', nameUtf8: 'Jos\ufffd',
    nameLatin1: Buffer.from('4a6f73e9204a75616e', 'hex').toString('latin1') }];
  try {
    const snapshot = await downloadEmployeeSnapshot(device);
    assert.equal(snapshot.employees[0].employeeId, '68');
    assert.equal(snapshot.employees[0].uid, '7');
    assert.equal(snapshot.employees[0].name, 'Jos\u00e9 Juan');
    assert.equal(snapshot.employees[0].nameStatus, 'device');
    saveEmployees(device.id, snapshot.employees);
    assert.equal(getEmployees(device.id)[0].name, 'Jos\u00e9 Juan');
    assert.equal(rawEvents(device.id).length, 0);
  } finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
});

test('unreadable names use only the explicit ID when the placeholder policy is authorized', async () => {
  const device = addDevice({ name: 'Unreadable clock names', ip: '127.0.0.4', namesFromDevice: true,
    nameEncoding: 'latin1', unreadableNamePolicy: 'placeholder' });
  users = [{ userId: '133', uid: 68, name: 'Wrong alias', nameLatin1: '\u00a8+\u0087' }];
  saveEmployees(device.id, [{ employeeId: '133', uid: '68', name: 'Previous name' }]);
  addStoredEvents(device.id, [{ employeeId: '133', deviceUserId: '133', uid: '500', timestamp: '2026-11-10T15:00:00Z' }], 'device');
  const before = rawEvents(device.id);
  try {
    const snapshot = await downloadEmployeeSnapshot(device);
    assert.equal(snapshot.employees[0].name, 'Colaborador 133');
    assert.equal(snapshot.employees[0].nameStatus, 'unreadable');
    assert.equal(snapshot.employees[0].employeeId, '133');
    saveEmployees(device.id, snapshot.employees);
    saveEmployees(device.id, [{ employeeId: '133', uid: '68', name: 'Legacy corrupted cache' }]);
    assert.equal(getEmployees(device.id)[0].name, 'Colaborador 133');
    assert.deepEqual(rawEvents(device.id), before);
    assert.equal(getStoredEvents(device.id)[0].employeeId, '133');
  } finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
});

test('placeholder settings cannot bypass explicit IDs, roster completeness or encoding validation', async () => {
  const device = addDevice({ name: 'Strict placeholders', ip: '127.0.0.5', namesFromDevice: true,
    nameEncoding: 'latin1', unreadableNamePolicy: 'placeholder' });
  users = [{ uid: 133, nameLatin1: '\u0087' }];
  try { await assert.rejects(downloadEmployeeSnapshot(device), /ID explicito/); }
  finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
  await assert.rejects(downloadEmployeeSnapshot(device), /bytes originales/);
  await assert.rejects(downloadEmployeeSnapshot({ ...device, nameEncoding: 'unknown' }), /no esta soportada/);
  users = [{ userId: '133', uid: 68, nameLatin1: '\u0001 Corrupted' }];
  try { await assert.rejects(downloadEmployeeSnapshot({ ...device, unreadableNamePolicy: undefined }), /codificacion/); }
  finally { users = [{ userId: '1', uid: 44, name: 'Sebastian' }]; }
});
