const express = require('express');
const cors = require('cors');
const {
  getDeviceConfig,
  readDeviceDiagnostics,
  readDeviceStatus,
  withDevice,
} = require('./services/zkteco');
const {
  getDevices,
  getDeviceById,
  addDevice,
  updateDevice,
  deleteDevice,
  updateEmployeeName,
  saveEmployees,
} = require('./services/db');
const { addStoredEvents, parseAttendanceFile } = require('./services/eventStore');
const { getSavedAttendance } = require('./services/attendanceStore');
const { syncAttendance } = require('./services/syncAttendance');
const { db } = require('./services/sqlite');
const { createEnrollmentManager } = require('./services/enrollment');
const { getRealtimeStatus, startRealtime, stopRealtime } = require('./services/realtime');
const {
  authenticate,
  getSession,
  removeSession,
  getUsers,
  createUser,
  updateUser,
  deleteUser
} = require('./services/auth');

const app = express();
const enrollments = createEnrollmentManager({ db, withDevice, getDeviceById, getRealtimeStatus, saveEmployees });
const port = Number(process.env.API_PORT || 5174);

app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// Auth Middleware
function authMiddleware(req, res, next) {
  const path = req.path;
  if (!path.startsWith('/api')) {
    return next();
  }

  if (path === '/api/auth/login' || path === '/api/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Acceso no autorizado. Inicie sesión.' });
  }

  const token = authHeader.substring(7);
  const user = getSession(token);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'Sesión inválida o expirada. Inicie sesión nuevamente.' });
  }

  req.user = user;
  const requiresDevice = path.startsWith('/api/events') || path.startsWith('/api/employees') || path.startsWith('/api/device/');
  const newDeviceDiagnostic = path === '/api/device/diagnostics' && user.role === 'admin';
  if (requiresDevice && !req.query.deviceId && !newDeviceDiagnostic) {
    return res.status(400).json({ message: 'Seleccione el biometrico.' });
  }
  next();
}

app.use(authMiddleware);

// Admin Role Check Middleware
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, message: 'Acceso denegado. Se requieren privilegios de administrador.' });
  }
  next();
}

function getRequestDevice(req) {
  const deviceId = req.query.deviceId;
  const list = getDevices();
  
  // Filter devices list for standard users
  const allowedDevices = (!req.user || req.user.role === 'admin')
    ? list
    : list.filter(d => (req.user.assignedDevices || []).includes(d.id));
     
  if (!deviceId) {
    return allowedDevices[0] || null;
  }
  
  const found = allowedDevices.find(d => String(d.id) === String(deviceId));
  return found || null;
}

function enrollmentDevice(req, res) {
  const device = getRequestDevice(req);
  if (!device) res.status(404).json({ message: 'Biometrico no encontrado o acceso denegado.' });
  return device;
}

app.get('/api/device/fingerprints', requireAdmin, async (req, res, next) => {
  const device = enrollmentDevice(req, res);
  if (!device) return;
  try { res.json(await enrollments.inspect(device, req.query.employeeId)); } catch (error) { next(error); }
});
app.get('/api/device/enrollments', requireAdmin, (req, res, next) => {
  const device = enrollmentDevice(req, res);
  if (!device) return;
  try { res.json({ job: enrollments.latest(device.id) }); } catch (error) { next(error); }
});
app.post('/api/device/enrollments', requireAdmin, (req, res, next) => {
  const device = enrollmentDevice(req, res);
  if (!device) return;
  try { res.status(202).json({ job: enrollments.start(device, req.user.id, req.body) }); } catch (error) { next(error); }
});
app.get('/api/device/enrollments/:id', requireAdmin, (req, res, next) => {
  const device = enrollmentDevice(req, res);
  if (!device) return;
  try { res.json({ job: enrollments.job(req.params.id, device.id) }); } catch (error) { next(error); }
});
app.post('/api/device/enrollments/:id/cancel', requireAdmin, (req, res, next) => {
  const device = enrollmentDevice(req, res);
  if (!device) return;
  try { res.json({ job: enrollments.cancel(req.params.id, device.id, req.user.id) }); } catch (error) { next(error); }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    device: getDeviceConfig(),
    serverTime: new Date().toISOString(),
  });
});

// Auth Route handlers
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'Usuario y contraseña requeridos.' });
  }
  const result = authenticate(username, password);
  if (!result) {
    return res.status(401).json({ ok: false, message: 'Usuario o contraseña incorrectos.' });
  }
  res.json({ ok: true, ...result });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    removeSession(token);
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Admin User Management routes
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = getUsers().map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    assignedDevices: u.assignedDevices || []
  }));
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const user = createUser(req.body);
    res.status(201).json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    const user = updateUser(req.params.id, req.body);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  try {
    deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

// Devices REST operations
app.get('/api/devices', (req, res) => {
  const list = getDevices();
  if (req.user && req.user.role !== 'admin') {
    const filtered = list.filter(d => (req.user.assignedDevices || []).includes(d.id));
    return res.json(filtered);
  }
  res.json(list);
});

app.post('/api/devices', requireAdmin, (req, res) => {
  const newDevice = addDevice(req.body);
  res.status(201).json(newDevice);
});

app.put('/api/devices/:id', (req, res) => {
  const deviceId = req.params.id;
  const isOperator = req.user.role !== 'admin';

  // Check permissions: Operator must have it in their assigned devices
  if (isOperator) {
    const assignedDevices = req.user.assignedDevices || [];
    if (!assignedDevices.includes(deviceId)) {
      return res.status(403).json({ ok: false, message: 'Acceso denegado. No tiene asignado este biométrico.' });
    }
  }

  // Load existing configuration
  const list = getDevices();
  const existingDevice = list.find(d => String(d.id) === String(deviceId));
  if (!existingDevice) {
    return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado.' });
  }

  let payload = req.body;
  if (isOperator) {
    // Lock identity fields for operators; copy only schedule settings
    payload = {
      ...existingDevice,
      shiftStart: req.body.shiftStart,
      shiftEnd: req.body.shiftEnd,
      satShiftStart: req.body.satShiftStart,
      satShiftEnd: req.body.satShiftEnd,
      graceMinutes: req.body.graceMinutes
    };
  }

  const updated = updateDevice(deviceId, payload);
  res.json(updated);
});

app.delete('/api/devices/:id', requireAdmin, (req, res) => {
  deleteDevice(req.params.id);
  res.json({ ok: true });
});

app.put('/api/employees/:id', (req, res) => {
  if (!req.query.deviceId) return res.status(400).json({ message: 'Seleccione el biometrico.' });
  const device = getRequestDevice(req);
  if (!device) return res.status(403).json({ message: 'Biometrico no autorizado.' });
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, message: 'El nombre es requerido.' });
  }
  const updated = updateEmployeeName(device.id, req.params.id, name);
  res.json({ ok: true, employee: updated });
});

app.get('/api/device/status', async (req, res, next) => {
  try {
    const device = getRequestDevice(req);
    if (!device) {
      return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
    }
    const status = await readDeviceStatus(device);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.get('/api/device/diagnostics', async (req, res) => {
  let device = getRequestDevice(req);
  if (req.user.role !== 'admin' && (!device || (req.query.ip && req.query.ip !== device.ip) || (req.query.port && Number(req.query.port) !== device.port))) {
    return res.status(403).json({ message: 'Biometrico no autorizado.' });
  }
  if (!device) {
    device = {};
  }
  const testDevice = {
    ...device,
    ip: req.query.ip || device.ip,
    port: req.query.port ? Number(req.query.port) : device.port,
  };
  if (!testDevice.ip) {
    return res.status(400).json({ ok: false, message: 'IP del biométrico requerida para diagnóstico.' });
  }
  const diagnostics = await readDeviceDiagnostics(testDevice);
  res.status(diagnostics.ok ? 200 : 503).json(diagnostics);
});

app.get('/api/device/realtime/status', (req, res) => {
  const device = getRequestDevice(req);
  if (!device) {
    return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
  }
  res.json({ ok: true, realtime: getRealtimeStatus(device.id) });
});

app.post('/api/device/realtime/start', async (req, res) => {
  if (enrollments.isBusy(req.query.deviceId)) return res.status(409).json({ message: 'Espere a que termine el registro de huella.' });
  const device = getRequestDevice(req);
  if (!device) {
    return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
  }
  const realtime = await startRealtime(device);
  res.status(realtime.active ? 200 : 503).json({ ok: realtime.active, realtime });
});

app.post('/api/device/realtime/stop', async (req, res) => {
  const device = getRequestDevice(req);
  if (!device) {
    return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
  }
  const realtime = await stopRealtime(device.id);
  res.json({ ok: true, realtime });
});

app.post('/api/events/import', (req, res) => {
  const device = getRequestDevice(req);
  if (!device) {
    return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
  }

  const parsed = parseAttendanceFile(req.body?.content || '');
  const inserted = addStoredEvents(device.id, parsed, req.body?.source || 'import');
  res.status(201).json({
    ok: true,
    parsed: parsed.length,
    inserted: inserted.length,
    device,
  });
});

app.get('/api/employees', async (req, res, next) => {
  try {
    if (!req.query.deviceId) return res.status(400).json({ message: 'Seleccione el biometrico.' });
    const device = getRequestDevice(req);
    if (!device) {
      return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
    }
    const snapshot = getSavedAttendance(device);
    res.json({
      device: snapshot.device,
      fetchedAt: snapshot.fetchedAt,
      employees: snapshot.employees,
      source: snapshot.source,
      sync: snapshot.sync,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/events', async (req, res, next) => {
  try {
    if (!req.query.deviceId) return res.status(400).json({ message: 'Seleccione el biometrico.' });
    const device = getRequestDevice(req);
    if (!device) {
      return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado o acceso denegado.' });
    }
    const snapshot = getSavedAttendance(device, {
      from: req.query.from,
      to: req.query.to,
      employeeId: req.query.employeeId,
    });
    const events = snapshot.events;

    res.json({
      device: snapshot.device,
      deviceInfo: snapshot.deviceInfo,
      fetchedAt: snapshot.fetchedAt,
      sync: snapshot.sync,
      source: snapshot.source,
      range: {
        from: req.query.from || null,
        to: req.query.to || null,
      },
      employees: snapshot.employees,
      events,
      totals: {
        employees: snapshot.employees.length,
        events: events.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Interactive downloads share the same device queue as the nightly scheduler.
app.post('/api/device/sync', async (req, res, next) => {
  const device = getRequestDevice(req);
  if (!device) return res.status(404).json({ message: 'Dispositivo no encontrado o acceso denegado.' });
  try {
    const snapshot = await syncAttendance(device);
    res.json({ ok: true, device: snapshot.device, fetchedAt: snapshot.fetchedAt, sync: snapshot.sync,
      totals: { employees: snapshot.employees.length, events: snapshot.events.length } });
  } catch (error) { next(error); }
});

// Serve static client assets in production
const path = require('path');
app.use(express.static(path.join(__dirname, '../dist')));

// Fallback all non-API calls to client SPA
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.use((error, req, res, _next) => {
  const status = error.statusCode || 503;
  const device = getRequestDevice(req) || getDeviceConfig();
  res.status(status).json({
    ok: false,
    message: error.publicMessage || 'No se pudo leer informacion del ZKTeco.',
    detail: error.message,
    device,
  });
});

if (require.main === module) {
let nightlyTask;
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`API ZKTeco lista en http://127.0.0.1:${port}`);
  if (process.env.ASISTENCIA_DAILY_SYNC === '1' ||
      (process.env.NODE_ENV === 'production' && process.env.ASISTENCIA_DAILY_SYNC !== '0')) {
    nightlyTask = require('./services/nightlySync').startNightlySync();
  }
});
process.once('SIGTERM', async () => {
  nightlyTask?.stop();
  const timeout = setTimeout(() => process.exit(1), 25000);
  await enrollments.shutdown();
  server.close(() => { clearTimeout(timeout); process.exit(0); });
});
}

module.exports = app;
