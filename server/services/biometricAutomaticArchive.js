const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { encryptBackup, decryptBackup } = require('./biometricBackup');
const { decryptArchive, MAX_ARCHIVE } = require('./biometricArchive');
const { enrollmentError } = require('./zkEnrollment');
const generateKeyPair = promisify(crypto.generateKeyPair);

function parseKey(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  const bits = privateKey.asymmetricKeyDetails?.modulusLength;
  if (privateKey.asymmetricKeyType !== 'rsa' || bits < 3072 || bits > 8192) throw new Error('Unsupported key');
  const publicKey = crypto.createPublicKey(privateKey);
  const keyId = crypto.createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  return { privateKey, publicKey, keyId };
}

function createAutomaticArchive({ directory, privateKey } = {}) {
  if (!directory && !privateKey) throw new Error('A private key directory is required');
  const filename = directory && path.join(directory, 'recovery-key.pem');
  let loaded = privateKey ? parseKey(privateKey) : null;
  let creating;
  async function keys(create) {
    if (loaded) return loaded;
    if (creating) return creating;
    creating = (async () => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Invalid key directory');
      if (!fs.existsSync(filename)) {
        if (!create) throw enrollmentError('Este servidor no tiene la clave del respaldo. Seleccione su archivo de clave de recuperacion.', 409);
        const pair = await generateKeyPair('rsa', { modulusLength: 3072,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
        let fd;
        try { fd = fs.openSync(filename, 'wx', 0o600); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (fd !== undefined) {
          try { fs.writeFileSync(fd, pair.privateKey); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
        }
      }
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid key file');
      fs.chmodSync(filename, 0o600);
      // An unreadable/corrupt key is never replaced: older archives depend on it.
      loaded = parseKey(fs.readFileSync(filename));
      return loaded;
    })();
    try { return await creating; }
    catch (error) { throw error.publicMessage ? error : enrollmentError('No se pudo abrir la clave de recuperacion del servidor. No se reemplazo la clave existente.', 503); }
    finally { creating = null; }
  }
  return {
    async encrypt(payload) {
      const key = await keys(true);
      const buffer = encryptBackup(payload, key.publicKey.export({ type: 'spki', format: 'pem' }), { keyId: key.keyId });
      if (buffer.length > MAX_ARCHIVE) throw enrollmentError('El respaldo supera el limite de 16 MB.', 413);
      return buffer;
    },
    async decrypt(encoded, options = {}) {
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_ARCHIVE / 3) * 4) throw enrollmentError('Seleccione un respaldo de hasta 16 MB.', 413);
      const data = Buffer.from(encoded, 'base64');
      if (data.length > MAX_ARCHIVE || data.toString('base64') !== encoded) throw enrollmentError('Archivo de respaldo invalido.', 400);
      let envelope;
      try { envelope = JSON.parse(data.toString('utf8')); }
      catch { throw enrollmentError('El archivo no es un respaldo ASISTO valido.', 400); }
      if (envelope.version === 2) {
        if (typeof options.password === 'string') return decryptArchive(encoded, options.password);
        throw enrollmentError('Este archivo anterior esta protegido por contrasena. Descargue un respaldo nuevo sin contrasena; el archivo anterior no se modifica.', 422);
      }
      if (envelope.format !== 'asisto-biometric-backup' || ![1, 3].includes(envelope.version) || envelope.encryption !== 'RSA-OAEP-SHA256+AES-256-GCM' ||
          (envelope.version === 3 && !/^[a-f0-9]{64}$/.test(envelope.keyId))) throw enrollmentError('Formato de respaldo no compatible.', 422);
      let key;
      if (options.recoveryKey) {
        if (typeof options.recoveryKey !== 'string' || Buffer.byteLength(options.recoveryKey) > 16384) throw enrollmentError('El archivo de clave no es valido.', 400);
        try { key = parseKey(options.recoveryKey); }
        catch { throw enrollmentError('El archivo seleccionado no es una clave de recuperacion valida.', 400); }
      } else key = await keys(false);
      if (envelope.version === 3 && envelope.keyId !== key.keyId) throw enrollmentError('La clave no corresponde al respaldo. Seleccione la clave de recuperacion con la que se genero.', 409);
      try { return decryptBackup(data, key.privateKey); }
      catch {
        const error = enrollmentError('No se pudo verificar el archivo con esta clave. Revise que el respaldo y su clave sean los correctos.', 400);
        error.code = 'BACKUP_AUTH_FAILED';
        throw error;
      }
    },
    async exportKey() {
      const key = await keys(true);
      return { buffer: Buffer.from(key.privateKey.export({ type: 'pkcs8', format: 'pem' })), keyId: key.keyId,
        filename: `asisto-recovery-${key.keyId.slice(0, 16)}.zkkey` };
    },
  };
}

module.exports = { createAutomaticArchive };
