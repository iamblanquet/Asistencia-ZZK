const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const dataDir = process.env.ASISTENCIA_DATA_DIR || path.join(__dirname, '../data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const filename = path.join(dataDir, 'asistencia.sqlite');
const db = new Database(filename);
fs.chmodSync(filename, 0o600);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, config TEXT NOT NULL CHECK(json_valid(config)), deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS employees (
    device_id TEXT NOT NULL REFERENCES devices(id), employee_id TEXT NOT NULL,
    name TEXT NOT NULL, override_name TEXT, uid TEXT, role INTEGER, card_no TEXT,
    PRIMARY KEY(device_id, employee_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    device_id TEXT NOT NULL, employee_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    local_date TEXT NOT NULL, local_time TEXT NOT NULL, source TEXT NOT NULL,
    device_user_id TEXT, uid TEXT,
    PRIMARY KEY(device_id, employee_id, timestamp),
    FOREIGN KEY(device_id, employee_id) REFERENCES employees(device_id, employee_id)
  );
  CREATE INDEX IF NOT EXISTS events_device_date ON events(device_id, local_date, timestamp);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('admin','user')),
    credentials TEXT NOT NULL CHECK(json_valid(credentials))
  );
  CREATE TABLE IF NOT EXISTS user_devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id), PRIMARY KEY(user_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS migration_issues (
    id INTEGER PRIMARY KEY, reason TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_sync_status (
    device_id TEXT PRIMARY KEY REFERENCES devices(id),
    last_success TEXT, last_attempt TEXT, last_error TEXT,
    device_info TEXT CHECK(device_info IS NULL OR json_valid(device_info))
  );
  CREATE TABLE IF NOT EXISTS nightly_sync_runs (
    day TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
    results TEXT NOT NULL CHECK(json_valid(results))
  );
  CREATE TABLE IF NOT EXISTS enrollment_jobs (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
    employee_id TEXT NOT NULL, finger_index INTEGER NOT NULL CHECK(finger_index BETWEEN 0 AND 9),
    actor_id TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
    deadline TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
    result TEXT CHECK(result IS NULL OR json_valid(result))
  );
  CREATE INDEX IF NOT EXISTS enrollment_device_created ON enrollment_jobs(device_id,created_at);
  CREATE TABLE IF NOT EXISTS employee_device_status (
    device_id TEXT NOT NULL, employee_id TEXT NOT NULL, present INTEGER NOT NULL CHECK(present IN (0,1)),
    checked_at TEXT NOT NULL, PRIMARY KEY(device_id,employee_id),
    FOREIGN KEY(device_id,employee_id) REFERENCES employees(device_id,employee_id)
  );
  CREATE TABLE IF NOT EXISTS device_user_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), employee_id TEXT NOT NULL,
    actor_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('rename','delete')),
    status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
    details TEXT NOT NULL CHECK(json_valid(details))
  );
  CREATE TABLE IF NOT EXISTS biometric_backup_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), actor_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('export','preview','restore')), employee_id TEXT,
    status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
    details TEXT NOT NULL CHECK(json_valid(details))
  );
  CREATE INDEX IF NOT EXISTS biometric_backup_device_created ON biometric_backup_actions(device_id,created_at);
  CREATE TABLE IF NOT EXISTS report_schedule_groups (
    device_id TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE, revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(device_id,id), UNIQUE(device_id,name)
  );
  CREATE TABLE IF NOT EXISTS report_schedule_versions (
    device_id TEXT NOT NULL, group_id TEXT NOT NULL, effective_from TEXT NOT NULL,
    settings TEXT NOT NULL CHECK(json_valid(settings)),
    PRIMARY KEY(device_id,group_id,effective_from),
    FOREIGN KEY(device_id,group_id) REFERENCES report_schedule_groups(device_id,id)
  );
  CREATE TABLE IF NOT EXISTS employee_schedule_assignments (
    device_id TEXT NOT NULL, employee_id TEXT NOT NULL, effective_from TEXT NOT NULL,
    group_id TEXT,
    PRIMARY KEY(device_id,employee_id,effective_from),
    FOREIGN KEY(device_id,employee_id) REFERENCES employees(device_id,employee_id),
    FOREIGN KEY(device_id,group_id) REFERENCES report_schedule_groups(device_id,id)
  );
  CREATE TABLE IF NOT EXISTS report_schedule_audit (
    id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
    group_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    details TEXT NOT NULL CHECK(json_valid(details))
  );
  CREATE TABLE IF NOT EXISTS report_general_schedule_state (
    device_id TEXT PRIMARY KEY REFERENCES devices(id), revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS report_general_schedule_versions (
    device_id TEXT NOT NULL REFERENCES report_general_schedule_state(device_id),
    effective_from TEXT NOT NULL, settings TEXT NOT NULL CHECK(json_valid(settings)),
    PRIMARY KEY(device_id,effective_from)
  );
`);

function legacy(name, fallback) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const putDevice = db.prepare('INSERT INTO devices(id,config) VALUES (?,?)');
const putEmployee = db.prepare(`INSERT INTO employees(device_id,employee_id,name,uid,role,card_no)
  VALUES (@deviceId,@employeeId,@name,@uid,@role,@cardNo)
  ON CONFLICT(device_id,employee_id) DO UPDATE SET name=excluded.name,
  uid=COALESCE(excluded.uid,employees.uid), role=COALESCE(excluded.role,employees.role),
  card_no=COALESCE(excluded.card_no,employees.card_no)`);
const putEvent = db.prepare(`INSERT OR IGNORE INTO events
  (device_id,employee_id,timestamp,local_date,local_time,source,device_user_id,uid)
  VALUES (@deviceId,@employeeId,@timestamp,@localDate,@localTime,@source,@deviceUserId,@uid)`);
function employee(deviceId, value) {
  putEmployee.run({ deviceId: String(deviceId), employeeId: String(value.employeeId),
    name: value.name || value.employeeName || `Colaborador ${value.employeeId}`,
    uid: value.uid == null ? null : String(value.uid), role: value.role ?? null,
    cardNo: value.cardNo == null ? null : String(value.cardNo) });
}
function insertEvent(deviceId, value, source) {
  const time = new Date(value.timestamp);
  if (!value.employeeId || !Number.isFinite(time.getTime())) throw new Error('Evento sin colaborador o fecha valida.');
  if (!db.prepare('SELECT 1 FROM employees WHERE device_id=? AND employee_id=?').get(deviceId, String(value.employeeId))) employee(deviceId, value);
  return putEvent.run({ deviceId, employeeId: String(value.employeeId), timestamp: time.toISOString(),
    localDate: value.localDate || `${time.getFullYear()}-${String(time.getMonth()+1).padStart(2,'0')}-${String(time.getDate()).padStart(2,'0')}`,
    localTime: value.localTime || `${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`,
    source: source || value.source || 'migration', deviceUserId: String(value.deviceUserId || value.employeeId), uid: String(value.uid || '') }).changes;
}

if (!db.prepare('SELECT 1 FROM migrations WHERE version=1').get()) {
  const legacyFiles = fs.readdirSync(dataDir).filter(f => /\.(db|json)$/.test(f));
  if (legacyFiles.length) {
    const backup = path.join(dataDir, 'pre-sqlite-' + Date.now());
    fs.mkdirSync(backup, { mode: 0o700 });
    for (const file of legacyFiles) fs.copyFileSync(path.join(dataDir, file), path.join(backup, file));
  }
  db.transaction(() => {
    let devices = legacy('devices.db', legacy('devices.json', []));
    if (!devices.length && !fs.existsSync(path.join(dataDir, 'devices.db')) && !fs.existsSync(path.join(dataDir, 'devices.json'))) {
      devices = [{ id: 'dev-default', name: 'ZKTeco Oficina', ip: '172.28.10.105', port: 4370 }];
    }
    for (const device of devices) putDevice.run(String(device.id), JSON.stringify(device));
    const validDevices = new Set(devices.map(d => String(d.id)));
    const issues = db.prepare('INSERT INTO migration_issues(reason,payload) VALUES (?,?)');
    const events = legacy('events.db', []);
    for (const file of fs.readdirSync(dataDir).filter(f => /^snapshot-.*\.json$/.test(f))) {
      const snapshot = legacy(file, {});
      const deviceId = String(snapshot.device?.id || '');
      if (!validDevices.has(deviceId)) continue;
      for (const value of snapshot.employees || []) employee(deviceId, value);
      events.push(...(snapshot.events || []).map(e => ({ ...e, deviceId })));
    }
    for (const event of events) {
      const id = String(event.deviceId || '');
      if (!validDevices.has(id)) { issues.run('Evento sin dispositivo conocido', JSON.stringify(event)); continue; }
      insertEvent(id, event);
    }
    const overrides = legacy('employee_overrides.db', legacy('employee-names.json', {}));
    for (const [id, name] of Object.entries(overrides)) {
      const matches = db.prepare('SELECT device_id FROM employees WHERE employee_id=?').all(id);
      if (matches.length === 1) db.prepare('UPDATE employees SET override_name=? WHERE device_id=? AND employee_id=?').run(name, matches[0].device_id, id);
      else if (devices.length === 1 && matches.length === 0) {
        employee(String(devices[0].id), { employeeId: id, name });
        db.prepare('UPDATE employees SET override_name=? WHERE device_id=? AND employee_id=?').run(name, String(devices[0].id), id);
      } else issues.run('Nombre global ambiguo; requiere asignar biometrico', JSON.stringify({ employeeId: id, name }));
    }
    let users = legacy('users.db', null);
    if (!users) {
      const access = legacy('access.json', null);
      if (access) users = [access];
      else {
        const password = process.env.INITIAL_ADMIN_PASSWORD;
        if (!password || password.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD requiere al menos 12 caracteres.');
        const salt = crypto.randomBytes(16).toString('hex');
        users = [{ id: 'usr-admin', username: 'admin', role: 'admin', salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }];
      }
    }
    for (const user of users) {
      db.prepare('INSERT INTO users(id,username,role,credentials) VALUES (?,?,?,?)').run(user.id, user.username, user.role, JSON.stringify({ password: user.password, hash: user.hash, salt: user.salt }));
      for (const id of user.assignedDevices || []) {
        if (validDevices.has(String(id))) db.prepare('INSERT OR IGNORE INTO user_devices VALUES (?,?)').run(user.id, String(id));
      }
    }
    db.prepare('INSERT INTO migrations VALUES (1,?)').run(new Date().toISOString());
  })();
}
db.prepare('INSERT OR IGNORE INTO migrations(version,applied_at) VALUES (2,?)').run(new Date().toISOString());
module.exports = { db, dataDir, employee, insertEvent };
