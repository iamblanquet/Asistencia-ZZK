const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, '../data');
const dbPath = path.join(dbDir, 'devices.db');

const defaultDeviceFields = {
  model: 'WL20/EWL20',
  protocol: 'zk',
  port: 4370,
  timeout: 15000,
  inport: 4000,
  shiftStart: '08:00',
  shiftEnd: '17:00',
  satShiftStart: '08:00',
  satShiftEnd: '13:00',
  graceMinutes: 10,
};

function initDb() {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (!fs.existsSync(dbPath)) {
    const defaultDevices = [
      {
        id: 'dev-default',
        name: 'ZKTeco Oficina',
        model: defaultDeviceFields.model,
        protocol: defaultDeviceFields.protocol,
        ip: '172.28.10.105',
        port: defaultDeviceFields.port,
        timeout: defaultDeviceFields.timeout,
        inport: defaultDeviceFields.inport,
        shiftStart: defaultDeviceFields.shiftStart,
        shiftEnd: defaultDeviceFields.shiftEnd,
        satShiftStart: defaultDeviceFields.satShiftStart,
        satShiftEnd: defaultDeviceFields.satShiftEnd,
        graceMinutes: defaultDeviceFields.graceMinutes
      }
    ];
    fs.writeFileSync(dbPath, JSON.stringify(defaultDevices, null, 2), 'utf8');
  }
}

function getDevices() {
  initDb();
  try {
    const content = fs.readFileSync(dbPath, 'utf8');
    const devices = JSON.parse(content) || [];
    return devices.map(normalizeDevice);
  } catch (error) {
    console.error('Error reading devices.db:', error);
    return [];
  }
}

function saveDevices(devices) {
  initDb();
  try {
    fs.writeFileSync(dbPath, JSON.stringify(devices, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing to devices.db:', error);
    return false;
  }
}

function getDeviceById(id) {
  const devices = getDevices();
  return devices.find(d => String(d.id) === String(id)) || null;
}

function addDevice(device) {
  const devices = getDevices();
  const newDevice = normalizeDevice({
    id: `dev-${Date.now()}`,
    name: device.name || 'Nuevo Dispositivo',
    ip: device.ip || '127.0.0.1',
    ...device,
  });
  devices.push(newDevice);
  saveDevices(devices);
  return newDevice;
}

function updateDevice(id, data) {
  const devices = getDevices();
  const index = devices.findIndex(d => String(d.id) === String(id));
  if (index === -1) {
    return null;
  }
  const updatedDevice = {
    ...devices[index],
    name: data.name ?? devices[index].name,
    model: data.model ?? devices[index].model,
    protocol: data.protocol ?? devices[index].protocol,
    ip: data.ip ?? devices[index].ip,
    port: data.port ? Number(data.port) : devices[index].port,
    timeout: data.timeout ? Number(data.timeout) : devices[index].timeout,
    inport: data.inport ? Number(data.inport) : devices[index].inport,
    shiftStart: data.shiftStart ?? devices[index].shiftStart,
    shiftEnd: data.shiftEnd ?? devices[index].shiftEnd,
    satShiftStart: data.satShiftStart ?? devices[index].satShiftStart,
    satShiftEnd: data.satShiftEnd ?? devices[index].satShiftEnd,
    graceMinutes: data.graceMinutes !== undefined ? Number(data.graceMinutes) : devices[index].graceMinutes
  };
  devices[index] = normalizeDevice(updatedDevice);
  saveDevices(devices);
  return devices[index];
}

function deleteDevice(id) {
  const devices = getDevices();
  const filtered = devices.filter(d => String(d.id) !== String(id));
  saveDevices(filtered);
  return true;
}

function normalizeDevice(device) {
  return {
    id: String(device.id || `dev-${Date.now()}`),
    name: device.name || 'ZKTeco WL20/EWL20',
    model: device.model || defaultDeviceFields.model,
    protocol: device.protocol || defaultDeviceFields.protocol,
    ip: device.ip || '127.0.0.1',
    port: Number(device.port || defaultDeviceFields.port),
    timeout: Number(device.timeout || defaultDeviceFields.timeout),
    inport: Number(device.inport || defaultDeviceFields.inport),
    shiftStart: device.shiftStart || defaultDeviceFields.shiftStart,
    shiftEnd: device.shiftEnd || defaultDeviceFields.shiftEnd,
    satShiftStart: device.satShiftStart || defaultDeviceFields.satShiftStart,
    satShiftEnd: device.satShiftEnd || defaultDeviceFields.satShiftEnd,
    graceMinutes: Number(device.graceMinutes ?? defaultDeviceFields.graceMinutes),
  };
}

const overridesPath = path.join(dbDir, 'employee_overrides.db');

function getEmployeeOverrides() {
  if (!fs.existsSync(overridesPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(overridesPath, 'utf8');
    return JSON.parse(content) || {};
  } catch (error) {
    console.error('Error reading employee_overrides.db:', error);
    return {};
  }
}

function saveEmployeeOverrides(overrides) {
  initDb();
  try {
    fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing to employee_overrides.db:', error);
    return false;
  }
}

function updateEmployeeName(employeeId, name) {
  const overrides = getEmployeeOverrides();
  overrides[String(employeeId)] = name;
  saveEmployeeOverrides(overrides);
  return { employeeId, name };
}

module.exports = {
  getDevices,
  getDeviceById,
  addDevice,
  updateDevice,
  deleteDevice,
  getEmployeeOverrides,
  updateEmployeeName
};
