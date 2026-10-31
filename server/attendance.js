const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const ZKLib = require('node-zklib');
const dir = path.join(__dirname, 'data');
function read(name, fallback) {
  const file = path.join(dir, name + '.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
function write(name, value) {
  const file = path.join(dir, name + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const initial = [{ id: 'dev-default', name: 'Thessa', model: 'WL20/EWL20', protocol: 'zk', ip: '172.28.10.105', port: 4370, shiftStart: '08:00', shiftEnd: '17:00', satShiftStart: '08:00', satShiftEnd: '13:00', graceMinutes: 10 }];
function devices() { return read('devices', initial); }
function saveDevice(input, id) {
  const list = devices();
  const previous = id ? list.find(d => d.id === id) : null;
  if (id && !previous) throw new Error('Dispositivo no encontrado.');
  const next = { ...(previous || initial[0]), ...input, id: id || crypto.randomUUID() };
  if (!net.isIP(next.ip) || !Number.isInteger(Number(next.port)) || next.port < 1 || next.port > 65535 || !String(next.name || '').trim()) throw new Error('Nombre, IP o puerto no validos.');
  next.port = Number(next.port);
  if (next.protocol !== 'zk') throw new Error('Solo se admite lectura mediante protocolo ZK.');
  write('devices', previous ? list.map(d => d.id === id ? next : d) : [...list, next]);
  return next;
}
function deleteDevice(id) { write('devices', devices().filter(d => d.id !== id)); }
function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
const pending = new Map();
async function connect(zk) {
  let timer;
  try {
    await Promise.race([
      zk.createSocket(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Tiempo de conexion agotado. El equipo no responde en la red.'));
          zk.zklibTcp.socket?.destroy();
          try { zk.zklibUdp.socket?.close(); } catch {}
        }, 10000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
async function snapshot(device) {
  if (pending.has(device.id)) return pending.get(device.id);
  const task = readSnapshot(device).finally(() => pending.delete(device.id));
  pending.set(device.id, task);
  return task;
}
async function readSnapshot(device) {
  const zk = new ZKLib(device.ip, device.port, 8000, 0);
  try {
    await connect(zk);
    const users = await zk.getUsers();
    if (users.err) throw users.err;
    const attendance = await zk.getAttendances();
    if (attendance.err) throw attendance.err;
    const aliases = read('employee-names', {});
    const employees = users.data.map(u => ({ employeeId: String(u.userId ?? u.uid), name: aliases[String(u.userId ?? u.uid)] || u.name || String(u.userId ?? u.uid), role: u.role, cardNo: u.cardno }));
    const lookup = new Map(employees.map(e => [e.employeeId, e.name]));
    const cacheKey = 'snapshot-' + crypto.createHash('sha256').update(device.id).digest('hex');
    const old = read(cacheKey, { events: [] });
    const merged = new Map(old.events.map(e => [e.id, e]));
    for (const log of attendance.data) {
      const time = new Date(log.recordTime);
      if (!Number.isFinite(time.getTime())) continue;
      const employeeId = String(log.deviceUserId ?? log.userId ?? log.userSn);
      const timestamp = time.toISOString();
      const id = crypto.createHash('sha256').update(`${device.id}:${employeeId}:${timestamp}`).digest('hex');
      merged.set(id, { id, employeeId, employeeName: lookup.get(employeeId) || employeeId, timestamp, localDate: localDate(time) });
    }
    let deviceInfo = null;
    try { deviceInfo = await zk.getInfo(); } catch { /* Logs remain usable when firmware omits device information. */ }
    if (!attendance.data.length && Number(deviceInfo?.logCounts) > 0 && !merged.size) throw new Error('El equipo reporta registros pero no los entrega por el protocolo ZK. No se modifico su configuracion.');
    const result = { device, employees, events: [...merged.values()].map(e => ({ ...e, employeeName: aliases[e.employeeId] || lookup.get(e.employeeId) || e.employeeName })), deviceInfo, fetchedAt: new Date().toISOString() };
    write(cacheKey, result);
    return result;
  } finally {
    try { await zk.disconnect(); } catch { /* Close sockets even if connection setup failed. */ }
    zk.zklibTcp.socket?.destroy();
    try { zk.zklibUdp.socket?.close(); } catch {}
  }
}
async function diagnostics(device) {
  const zk = new ZKLib(device.ip, device.port, 5000, 0);
  try {
    await connect(zk);
    return { ok: true, device, deviceName: device.name, transport: zk.connectionType, deviceInfo: await zk.getInfo() };
  } finally {
    try { await zk.disconnect(); } catch {}
    zk.zklibTcp.socket?.destroy();
    try { zk.zklibUdp.socket?.close(); } catch {}
  }
}
function renameEmployee(id, name) {
  if (!String(name || '').trim()) throw new Error('Nombre no valido.');
  write('employee-names', { ...read('employee-names', {}), [id]: String(name).trim() });
  return { employeeId: id, name: String(name).trim() };
}
module.exports = { devices, saveDevice, deleteDevice, snapshot, diagnostics, renameEmployee };
