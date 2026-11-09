const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asisto-identity-repair-'));
process.env.ASISTENCIA_DATA_DIR = directory;
process.env.INITIAL_ADMIN_PASSWORD = 'Identity-Repair-Fixture-2026';
const { db } = require('./services/sqlite');
const { addDevice, saveEmployees, getEmployees } = require('./services/db');
const { addStoredEvents, getStoredEvents } = require('./services/eventStore');
const { recordSyncSuccess } = require('./services/attendanceStore');
const { createAttendanceIdentityRepair } = require('./services/attendanceIdentityRepair');
const dependencies = { db, saveEmployees, addStoredEvents, recordSyncSuccess };

after(() => {
  db.close();
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('asisto-identity-repair-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function fixture(currentUsersOnly = true) {
  const device = addDevice({ name: 'Identity fixture', ip: '127.0.0.1', currentUsersOnly });
  const employees = [
    { employeeId: '2', uid: '37', name: 'Two' }, { employeeId: '3', uid: '38', name: 'Three' },
    { employeeId: '52', uid: '2', name: 'Fifty two' }, { employeeId: '53', uid: '3', name: 'Fifty three' },
  ];
  saveEmployees(device.id, employees);
  const events = [
    ['2', '37', '2026-11-09T14:01:03Z'], ['3', '38', '2026-11-09T14:02:57Z'],
    ['52', '2', '2026-07-20T22:00:07Z'], ['53', '3', '2026-07-28T13:17:59Z'],
    ['9', '19', '2026-11-07T14:00:00Z'],
  ].map(([employeeId, uid, time]) => ({ employeeId, deviceUserId: employeeId, uid,
    timestamp: new Date(time).toISOString(), identitySource: 'employee-id' }));
  const wrong = new Map([['2', '52'], ['3', '53'], ['9', '52']]);
  addStoredEvents(device.id, events.map(event => ({ ...event, employeeId: wrong.get(event.employeeId) || event.employeeId })), 'device');
  addStoredEvents(device.id, [{ employeeId: '2', timestamp: '2026-11-08T14:00:00Z' }], 'import');
  const download = { device, connectionType: 'tcp', deviceInfo: { logCounts: 5, userCounts: 4 }, employees, events };
  return { device, download, repair: createAttendanceIdentityRepair(dependencies) };
}

async function backup() {
  const filename = path.join(directory, randomUUID() + '.sqlite');
  await db.backup(filename);
  return filename;
}

test('rebuild uses only wire IDs and current collaborators and backs up all previous rows', async () => {
  const { device, download, repair } = fixture();
  const plan = repair.preview(device, download, { rebuild: true, expectedUsers: 4 });
  assert.equal(plan.summary.misassignedEvents, 3);
  assert.equal(plan.summary.reassignedEvents, 2);
  assert.equal(plan.summary.misassignedHistoricalEventsExcluded, 1);
  assert.equal(plan.summary.otherSourceEventsExcluded, 1);
  const filename = await backup();
  const result = repair.apply(device, download, plan, filename);
  assert.equal(result.savedEvents, 4);
  const saved = getStoredEvents(device.id);
  assert.deepEqual(saved.map(event => [event.employeeId, event.deviceUserId, event.uid]).sort(),
    [['2', '2', '37'], ['3', '3', '38'], ['52', '52', '2'], ['53', '53', '3']]);
  assert.ok(saved.every(event => event.source === 'device'));
  assert.equal(saved.filter(event => ['52', '53'].includes(event.employeeId) && event.localDate === '2026-11-09').length, 0);
  assert.equal(getEmployees(device.id).length, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance_identity_repairs WHERE device_id=?').get(device.id).n, 1);
  const Database = require('better-sqlite3');
  const copy = new Database(filename, { readonly: true, fileMustExist: true });
  try { assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM events WHERE device_id=?').get(device.id).n, 6); }
  finally { copy.close(); }
});

test('normal identity repair preserves other sources and complete historical device logs', async () => {
  const { device, download, repair } = fixture(false);
  const plan = repair.preview(device, download);
  repair.apply(device, download, plan, await backup());
  assert.equal(getStoredEvents(device.id).length, 6);
  assert.equal(getStoredEvents(device.id).filter(event => event.source === 'import').length, 1);
  assert.equal(getStoredEvents(device.id).find(event => event.employeeId === '9').deviceUserId, '9');
});

test('partial histories, UID-only records and a changed roster cannot modify saved data', () => {
  const { device, download, repair } = fixture();
  const before = getStoredEvents(device.id);
  assert.throws(() => repair.preview(device, { ...download, events: download.events.slice(1) }), /incompleto/);
  assert.throws(() => repair.preview(device, { ...download, connectionType: 'udp' }), /TCP/);
  assert.throws(() => repair.preview(device, { ...download, events: download.events.map(event => ({ ...event, identitySource: 'uid' })) }), /explicitamente/);
  assert.throws(() => repair.preview(device, download, { rebuild: true, expectedUsers: 40 }), /numero/);
  assert.deepEqual(getStoredEvents(device.id), before);
});

test('a stale plan or altered download is refused and no changes leak through', async () => {
  const { device, download, repair } = fixture();
  const plan = repair.preview(device, download, { rebuild: true });
  const filename = await backup();
  const changed = { ...download, events: download.events.map(event => ({ ...event, uid: '99' })) };
  assert.throws(() => repair.apply(device, changed, plan, filename), /cambio/);
  addStoredEvents(device.id, [{ employeeId: '2', timestamp: '2026-11-08T15:00:00Z' }], 'manual');
  const before = getStoredEvents(device.id);
  assert.throws(() => repair.apply(device, download, plan, filename), /cambio/);
  assert.deepEqual(getStoredEvents(device.id), before);
});

test('repairs require a matching backup and never modify another biometric', async () => {
  const target = fixture();
  const other = fixture();
  const untouched = getStoredEvents(other.device.id);
  const oldBackup = await backup();
  addStoredEvents(target.device.id, [{ employeeId: '2', timestamp: '2026-11-08T16:00:00Z' }], 'manual');
  const plan = target.repair.preview(target.device, target.download, { rebuild: true });
  assert.throws(() => target.repair.apply(target.device, target.download, plan), /respaldo/);
  assert.throws(() => target.repair.apply(target.device, target.download, plan, oldBackup), /respaldo/);
  target.repair.apply(target.device, target.download, plan, await backup());
  assert.deepEqual(getStoredEvents(other.device.id), untouched);
});

test('a storage error rolls back deleted events, roster and sync state atomically', async () => {
  const { device, download } = fixture();
  const repair = createAttendanceIdentityRepair({ ...dependencies, addStoredEvents: () => { throw new Error('Simulated write failure'); } });
  const before = getStoredEvents(device.id);
  const plan = repair.preview(device, download, { rebuild: true });
  const filename = await backup();
  assert.throws(() => repair.apply(device, download, plan, filename), /Simulated/);
  assert.deepEqual(getStoredEvents(device.id), before);
  assert.equal(db.prepare('SELECT last_success FROM device_sync_status WHERE device_id=?').get(device.id), undefined);
});

test('rebuilding twice is stable and removes only retired rows in the selected device', async () => {
  const { device, download, repair } = fixture();
  saveEmployees(device.id, [...download.employees, { employeeId: '90', uid: '90', name: 'Retired' }]);
  let plan = repair.preview(device, download, { rebuild: true });
  repair.apply(device, download, plan, await backup());
  const first = getStoredEvents(device.id);
  assert.equal(getEmployees(device.id).length, 4);
  plan = repair.preview(device, download, { rebuild: true });
  assert.equal(plan.summary.misassignedEvents, 0);
  repair.apply(device, download, plan, await backup());
  assert.deepEqual(getStoredEvents(device.id), first);
});

test('the local CLI refuses an external database path before opening or creating it', () => {
  const outside = path.join(directory, 'must-not-be-created');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'repair-attendance-identities.js'),
    '--device-id', 'dev-default', '--rebuild', '--apply'], {
    env: { ...process.env, ASISTENCIA_DATA_DIR: outside }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Solo se permiten bases/);
  assert.equal(fs.existsSync(outside), false);
});
