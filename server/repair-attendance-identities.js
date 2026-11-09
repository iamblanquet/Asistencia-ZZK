const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

async function main() {
  const { values } = parseArgs({ options: { 'device-id': { type: 'string' }, apply: { type: 'boolean', default: false },
    rebuild: { type: 'boolean', default: false }, 'expected-users': { type: 'string' } } });
  if (!values['device-id']) throw new Error('Indique --device-id. Sin --apply solo se muestra la vista previa.');
  const expectedUsers = values['expected-users'] === undefined ? undefined : Number(values['expected-users']);
  if (expectedUsers !== undefined && (!Number.isInteger(expectedUsers) || expectedUsers < 1)) throw new Error('--expected-users debe ser un entero positivo.');
  const envFile = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const relative = path.relative(path.resolve(__dirname, 'data'), path.resolve(process.env.ASISTENCIA_DATA_DIR || path.join(__dirname, 'data')));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Solo se permiten bases dentro de server/data de esta copia local.');
  const { downloadAttendanceSnapshot } = require('./services/zkteco');
  const { db, dataDir } = require('./services/sqlite');
  const { getDeviceById, saveEmployees } = require('./services/db');
  const { addStoredEvents } = require('./services/eventStore');
  const { recordSyncSuccess } = require('./services/attendanceStore');
  const { createAttendanceIdentityRepair } = require('./services/attendanceIdentityRepair');
  try {
    const device = getDeviceById(values['device-id']);
    if (!device) throw new Error('Biometrico no encontrado.');
    const download = await downloadAttendanceSnapshot(device);
    const repair = createAttendanceIdentityRepair({ db, saveEmployees, addStoredEvents, recordSyncSuccess });
    const plan = repair.preview(device, download, { rebuild: values.rebuild, expectedUsers });
    console.log(JSON.stringify({ stage: 'preview', deviceId: device.id, ip: device.ip, ...plan.summary }));
    if (!values.apply) return;
    const backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backup = path.join(backupDir, 'before-identity-repair-' + new Date().toISOString().replace(/[-:.]/g, '') + '.sqlite');
    if (fs.existsSync(backup)) throw new Error('El archivo de respaldo ya existe.');
    await db.backup(backup);
    const Database = require('better-sqlite3');
    const copy = new Database(backup, { readonly: true, fileMustExist: true });
    try {
      if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('El respaldo no paso la verificacion de integridad.');
    } finally { copy.close(); }
    console.log(JSON.stringify({ stage: 'repaired', ...repair.apply(device, download, plan, backup) }));
  } finally { db.close(); }
}

const deadline = setTimeout(() => { console.error('Tiempo de espera agotado.'); process.exit(1); }, 120000);
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
