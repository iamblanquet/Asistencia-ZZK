const crypto = require('node:crypto');
const { db } = require('./sqlite');
const sessions = new Map();
function getUsers() {
  return db.prepare('SELECT * FROM users ORDER BY rowid').all().map(row => ({ id: row.id, username: row.username, role: row.role,
    ...JSON.parse(row.credentials), assignedDevices: db.prepare('SELECT device_id FROM user_devices WHERE user_id=?').all(row.id).map(d => d.device_id) }));
}
function profile(user) { return { id: user.id, username: user.username, role: user.role, assignedDevices: user.assignedDevices }; }
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('La contrasena requiere al menos 8 caracteres.');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function authenticate(username, password) {
  const user = getUsers().find(u => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user || typeof password !== 'string') return null;
  const actual = user.salt ? crypto.scryptSync(password, user.salt, 64) : crypto.createHash('sha256').update(password).digest();
  const expected = Buffer.from(user.hash || user.password, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expires: Date.now() + 8 * 60 * 60 * 1000 });
  return { token, user: profile(user) };
}
function getSession(token) {
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) { sessions.delete(token); return null; }
  const user = getUsers().find(u => u.id === session.userId);
  return user ? profile(user) : null;
}
function removeSession(token) { return sessions.delete(token); }
function assignments(userId, devices) {
  if (!Array.isArray(devices)) throw new Error('Lista de biometricos no valida.');
  db.prepare('DELETE FROM user_devices WHERE user_id=?').run(userId);
  for (const id of new Set(devices.map(String))) {
    if (!db.prepare('SELECT 1 FROM devices WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('Biometrico asignado no encontrado.');
    db.prepare('INSERT INTO user_devices VALUES (?,?)').run(userId, id);
  }
}
function createUser(data) {
  const username = String(data.username || '').trim();
  if (!username) throw new Error('Usuario requerido.');
  const id = 'usr-' + crypto.randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO users(id,username,role,credentials) VALUES (?,?,?,?)').run(id, username, data.role === 'admin' ? 'admin' : 'user', JSON.stringify(passwordHash(data.password)));
    assignments(id, data.assignedDevices || []);
  })();
  return profile(getUsers().find(u => u.id === id));
}
function updateUser(id, data) {
  const user = getUsers().find(u => u.id === id);
  if (!user) throw new Error('Usuario no encontrado.');
  if (id === 'usr-admin' && data.role && data.role !== 'admin') throw new Error('El administrador principal debe conservar su rol.');
  const username = data.username === undefined ? user.username : String(data.username).trim();
  if (!username) throw new Error('Usuario requerido.');
  db.transaction(() => {
    const credentials = data.password ? passwordHash(data.password) : { password: user.password, salt: user.salt, hash: user.hash };
    db.prepare('UPDATE users SET username=?,role=?,credentials=? WHERE id=?').run(username, data.role ? (data.role === 'admin' ? 'admin' : 'user') : user.role, JSON.stringify(credentials), id);
    if (data.assignedDevices !== undefined) assignments(id, data.assignedDevices);
  })();
  if (data.password) for (const [token, session] of sessions) if (session.userId === id) sessions.delete(token);
  return profile(getUsers().find(u => u.id === id));
}
function deleteUser(id) {
  if (id === 'usr-admin') throw new Error('No se puede eliminar el administrador principal.');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  for (const [token, session] of sessions) if (session.userId === id) sessions.delete(token);
  return true;
}
module.exports = { authenticate, getSession, removeSession, getUsers, createUser, updateUser, deleteUser };
