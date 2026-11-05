const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { captureBackup, encryptBackup, decryptBackup, backupSummary } = require('./services/biometricBackup');
const { decryptArchive } = require('./services/biometricArchive');

function writePrivateFile(filename, data) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(filename); throw error; }
  fs.closeSync(fd);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { ...Object.fromEntries(
    ['directory', 'input', 'output', 'public-key', 'private-key', 'ip', 'serial', 'device-id', 'name', 'port'].map(name => [name, { type: 'string' }]),
  ), 'password-stdin': { type: 'boolean' } } });
  assert.equal(positionals.length, 1, 'Use keygen, export o verify.');
  if (positionals[0] === 'keygen') {
    assert.ok(values.directory, 'Indique --directory fuera del repositorio.');
    fs.mkdirSync(values.directory, { recursive: true, mode: 0o700 });
    const privatePath = path.join(values.directory, 'biometric-backup-key.private.pem');
    const publicPath = path.join(values.directory, 'biometric-backup-key.public.pem');
    assert.ok(!fs.existsSync(privatePath) && !fs.existsSync(publicPath), 'Ya existe una clave en esta carpeta. No se reemplazara.');
    const pair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writePrivateFile(privatePath, pair.privateKey);
    writePrivateFile(publicPath, pair.publicKey);
    console.log(JSON.stringify({ privateKey: privatePath, publicKey: publicPath, algorithm: 'RSA-3072' }));
    return;
  }
  if (positionals[0] === 'verify') {
    assert.ok(values.input && values.serial, 'Indique --input y --serial.');
    const encrypted = fs.readFileSync(values.input);
    let payload;
    if (values['password-stdin']) {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 260, 'Entrada de contrasena demasiado larga.'); chunks.push(chunk); }
      const secret = Buffer.concat(chunks);
      try { payload = await decryptArchive(encrypted.toString('base64'), secret.toString('utf8').replace(/\r?\n$/, '')); }
      finally { secret.fill(0); chunks.forEach(chunk => chunk.fill(0)); }
    } else {
      assert.ok(values['private-key'], 'Indique --private-key para RSA o --password-stdin para un respaldo web.');
      payload = decryptBackup(encrypted, fs.readFileSync(values['private-key']));
    }
    assert.equal(payload.device.serial, values.serial, 'El respaldo pertenece a otro equipo.');
    console.log(JSON.stringify({ verified: true, ...backupSummary(payload), encryptedFileSha256: crypto.createHash('sha256').update(fs.readFileSync(values.input)).digest('hex') }));
    return;
  }
  assert.equal(positionals[0], 'export', 'Comando no compatible. No existe comando de restauracion.');
  assert.ok(values.ip && values.serial && values.output && values['public-key'], 'Indique --ip, --serial, --output y --public-key.');
  assert.ok(!fs.existsSync(values.output), 'El archivo de destino ya existe. No se reemplazara.');
  const publicKey = fs.readFileSync(values['public-key']);
  const parsed = crypto.createPublicKey(publicKey);
  assert.ok(parsed.asymmetricKeyType === 'rsa' && parsed.asymmetricKeyDetails.modulusLength >= 3072, 'Clave publica no compatible.');
  const ZKLib = require('zklib-js');
  const port = Number(values.port || 4370);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Puerto invalido.');
  const device = new ZKLib(values.ip, port, 15000, 4000);
  let timeout;
  try {
    timeout = setTimeout(() => { console.error('Tiempo maximo de respaldo agotado.'); process.exit(1); }, 180000);
    await device.createSocket();
    const payload = await captureBackup(device, { id: values['device-id'] || '', name: values.name || '', ip: values.ip, serial: values.serial });
    const encrypted = encryptBackup(payload, publicKey);
    writePrivateFile(values.output, encrypted);
    console.log(JSON.stringify({ saved: true, ...backupSummary(payload), encryptedBytes: encrypted.length,
      encryptedFileSha256: crypto.createHash('sha256').update(encrypted).digest('hex') }));
  } finally {
    clearTimeout(timeout);
    try { await device.disconnect(); } catch {}
  }
}

if (require.main === module) main().catch(() => {
  // Do not print packet contents, keys, user records or biometric templates in logs.
  console.error('No se completo la operacion de respaldo. Revise los parametros, la conectividad y la integridad del equipo/archivo.');
  process.exitCode = 1;
});

module.exports = { writePrivateFile };
