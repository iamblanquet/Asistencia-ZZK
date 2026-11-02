const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { db, dataDir } = require('./services/sqlite');
const knownDevices = new Set(db.prepare('SELECT id FROM devices').all().map(d => d.id));
const expected = new Set();
function collect(deviceId, event) {
  if (!knownDevices.has(String(deviceId))) return;
  expected.add(JSON.stringify([String(deviceId), String(event.employeeId), new Date(event.timestamp).toISOString()]));
}
const oldEvents = path.join(dataDir, 'events.db');
if (fs.existsSync(oldEvents)) for (const e of JSON.parse(fs.readFileSync(oldEvents, 'utf8'))) collect(e.deviceId, e);
for (const file of fs.readdirSync(dataDir).filter(f => /^snapshot-.*\.json$/.test(f))) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  for (const event of snapshot.events || []) collect(snapshot.device.id, event);
}
for (const row of db.prepare('SELECT device_id,employee_id,timestamp FROM events').all()) expected.delete(JSON.stringify([row.device_id, row.employee_id, row.timestamp]));
assert.equal(expected.size, 0, 'Faltan eventos de los archivos anteriores.');
assert.deepEqual(db.pragma('foreign_key_check'), []);
assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
const counts = {};
for (const table of ['devices', 'employees', 'events', 'users', 'user_devices', 'migration_issues']) counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
console.log(JSON.stringify({ integrity: 'ok', missingLegacyEvents: 0, counts, byDevice: db.prepare('SELECT device_id,count(*) AS events FROM events GROUP BY device_id').all() }));
