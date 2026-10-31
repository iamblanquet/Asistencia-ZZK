const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const attendance = require('./attendance');

const root = path.resolve(__dirname, '../dist');
const dataDir = path.join(__dirname, 'data');
const userFile = path.join(dataDir, 'access.json');
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(userFile)) {
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 12 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(userFile, JSON.stringify({ id: 'usr-admin', username: 'admin', role: 'admin', assignedDevices: [], salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }), { mode: 0o600 });
}
const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
const publicUser = { id: user.id, username: user.username, role: user.role, assignedDevices: user.assignedDevices };
const sessions = new Map();
let failedAttempts = 0;
let retryAt = 0;
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 8192) throw new Error('Request too large');
  }
  return JSON.parse(text || '{}');
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (Date.now() < retryAt) return json(res, 429, { message: 'Demasiados intentos. Espera un minuto.' });
      const input = await body(req);
      const hash = crypto.scryptSync(String(input.password || ''), user.salt, 64);
      if (input.username !== user.username || !crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) {
        if (++failedAttempts >= 5) { retryAt = Date.now() + 60000; failedAttempts = 0; }
        return json(res, 401, { message: 'Usuario o contrasena incorrectos.' });
      }
      failedAttempts = 0;
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      return json(res, 200, { token, user: publicUser });
    }
    if (url.pathname.startsWith('/api/')) {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if ((sessions.get(token) || 0) <= Date.now()) {
        sessions.delete(token);
        return json(res, 401, { message: 'Inicia sesion para continuar.' });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        sessions.delete(token);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/auth/me') return json(res, 200, { user: publicUser });
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, readOnly: true });
      if (url.pathname === '/api/devices' && req.method === 'GET') return json(res, 200, attendance.devices());
      if (url.pathname === '/api/devices' && req.method === 'POST') return json(res, 201, attendance.saveDevice(await body(req)));
      const deviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
      if (deviceMatch && req.method === 'PUT') return json(res, 200, attendance.saveDevice(await body(req), deviceMatch[1]));
      if (deviceMatch && req.method === 'DELETE') {
        attendance.deleteDevice(deviceMatch[1]);
        return json(res, 200, { ok: true });
      }
      const employeeMatch = url.pathname.match(/^\/api\/employees\/([^/]+)$/);
      if (employeeMatch && req.method === 'PUT') return json(res, 200, attendance.renameEmployee(employeeMatch[1], (await body(req)).name));
      if (['/api/events', '/api/employees', '/api/device/status', '/api/device/diagnostics'].includes(url.pathname)) {
        const deviceId = url.searchParams.get('deviceId');
        let device = deviceId ? attendance.devices().find(d => d.id === deviceId) : attendance.devices()[0];
        if (url.pathname === '/api/device/diagnostics' && url.searchParams.get('ip')) {
          const ip = url.searchParams.get('ip');
          const port = Number(url.searchParams.get('port') || 4370);
          if (!require('node:net').isIP(ip) || !Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { message: 'IP o puerto no validos.' });
          device = { ...device, ip, port };
        }
        if (!device) return json(res, 404, { message: 'Dispositivo no encontrado.' });
        try {
          if (url.pathname === '/api/device/diagnostics') return json(res, 200, await attendance.diagnostics(device));
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          const employeeId = url.searchParams.get('employeeId');
          if ([from, to].some(v => v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) || (from && to && from > to)) return json(res, 400, { message: 'Periodo no valido.' });
          const data = { ...await attendance.snapshot(device) };
          data.events = data.events.filter(e => (!from || e.localDate >= from) && (!to || e.localDate <= to) && (!employeeId || e.employeeId === employeeId));
          return json(res, 200, { ...data, totals: { employees: data.employees.length, events: data.events.length } });
        } catch (error) {
          const detail = error.message || error.err?.message || 'El equipo no responde.';
          console.error('Device read failed:', detail);
          return json(res, 503, { message: 'No se pudo leer el biometrico. Verifica la red y la IP. ' + detail, device });
        }
      }
      if (url.pathname === '/api/admin/users' && req.method === 'GET') return json(res, 200, [publicUser]);
      return json(res, 501, { message: 'Esta operacion todavia no esta implementada en la API recuperada.' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { message: 'Metodo no permitido.' });
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) return json(res, 403, { message: 'Acceso denegado.' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { message: 'Archivo no encontrado.' });
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch {
    json(res, 400, { message: 'Solicitud no valida.' });
  }
}).listen(Number(process.env.PORT || 5175), '127.0.0.1', () => console.log('Portal local: http://127.0.0.1:' + (process.env.PORT || 5175)));
