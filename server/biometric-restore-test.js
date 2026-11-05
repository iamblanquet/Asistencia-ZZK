const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const ZKLib = require('zklib-js');
const { testIdenticalRestore } = require('./services/biometricRestoreTest');
const { recoverDeletedUser } = require('./services/biometricUserRecovery');
const { writePrivateFile } = require('./biometric-backup');

async function main() {
  const { values } = parseArgs({ options: {
    ip: { type: 'string' }, serial: { type: 'string' }, 'employee-id': { type: 'string' },
    'finger-index': { type: 'string' }, execute: { type: 'boolean' }, report: { type: 'string' },
    'database': { type: 'string' },
    mode: { type: 'string' }, 'expected-name': { type: 'string' }, confirmed: { type: 'boolean' },
  } });
  assert.ok(values.ip && values.serial && values.database, 'Faltan IP, serie o base de datos de control.');
  assert.ok(values.mode === undefined || values.mode === 'recover-missing', 'Modo de prueba no compatible.');
  assert.ok(!values.report || !fs.existsSync(values.report), 'El reporte ya existe. No se reemplazara.');
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    assert.ok(length <= 192 * 1024 * 1024, 'Entrada demasiado grande.');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  let payload;
  try { payload = JSON.parse(input.toString('utf8')); }
  finally { input.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
  assert.ok(payload.device.ip === values.ip && payload.device.serial === values.serial, 'El respaldo no pertenece al destino confirmado.');
  const Database = require('better-sqlite3');
  const db = new Database(values.database, { readonly: true, fileMustExist: true });
  function beforeWrite() {
    const row = db.prepare('SELECT config FROM devices WHERE id=? AND deleted_at IS NULL').get(payload.device.id);
    assert.ok(row && JSON.parse(row.config).ip === values.ip, 'El dispositivo registrado cambio.');
    for (const table of ['enrollment_jobs', 'device_user_actions']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE device_id=? AND finished_at IS NULL`).get(payload.device.id).n, 0, 'Hay otra escritura activa en este reloj.');
    }
  }
  const device = new ZKLib(values.ip, 4370, 15000, 4000);
  let timeout;
  try {
    beforeWrite();
    timeout = setTimeout(() => { console.error('Tiempo maximo de prueba agotado. Requiere verificacion de solo lectura.'); process.exit(1); }, 180000);
    await device.createSocket();
    const selection = { employeeId: values['employee-id'], fingerIndex: values['finger-index'] === undefined ? undefined : Number(values['finger-index']),
      expectedName: values['expected-name'], confirmed: values.confirmed === true };
    const operation = values.mode === 'recover-missing' ? recoverDeletedUser : testIdenticalRestore;
    const result = await operation(device, payload, selection, { execute: values.execute === true, beforeWrite });
    if (values.report) writePrivateFile(values.report, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (!['ready', 'verified_identical_write', 'waiting_for_deletion', 'ready_to_restore', 'verified_user_recovery'].includes(result.status)) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    db.close();
    try { await device.disconnect(); } catch {}
  }
}

if (require.main === module) main().catch(() => {
  console.error('La prueba no se completo. No repita la escritura sin verificar primero el estado actual del reloj.');
  process.exitCode = 1;
});
