const fs = require('fs');
const path = require('path');

// SQLite needs the initial access settings before its first migration.
loadEnvFile();

const ZKLib = require('zklib-js');
const { REQUEST_DATA } = require('zklib-js/constants');
const {
  decodeRecordData40,
  decodeUserData72,
} = require('zklib-js/utils');
const { addStoredEvents } = require('./eventStore');
const { getEmployeeOverrides, saveEmployees, getEmployees } = require('./db');
const { db } = require('./sqlite');
const { getSavedAttendance, recordSyncSuccess } = require('./attendanceStore');
const { readTcpPreparedData, validateRecordBuffer } = require('./zkTcpDownload');
const { buildEmployeeIndex, resolveAttendanceIdentity } = require('./attendanceIdentity');

function loadEnvFile() {
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getDeviceConfig() {
  return {
    name: process.env.ZKTECO_NAME || 'ZKTeco WL20/EWL20',
    model: process.env.ZKTECO_MODEL || 'WL20/EWL20',
    protocol: process.env.ZKTECO_PROTOCOL || 'zk',
    ip: process.env.ZKTECO_IP || '172.28.10.105',
    port: Number(process.env.ZKTECO_PORT || 4370),
    timeout: Number(process.env.ZKTECO_TIMEOUT || 15000),
    inport: Number(process.env.ZKTECO_INPORT || 4000),
  };
}

let deviceQueue = Promise.resolve();

function enqueueDeviceWork(work) {
  const run = deviceQueue.catch(() => {}).then(work);
  deviceQueue = run.catch(() => {});
  return run;
}

async function withDevice(deviceConfig, work) {
  const config = {
    ...getDeviceConfig(),
    ...deviceConfig,
    port: Number(deviceConfig?.port || getDeviceConfig().port),
    timeout: Number(deviceConfig?.timeout || getDeviceConfig().timeout),
    inport: Number(deviceConfig?.inport || getDeviceConfig().inport),
  };
  return enqueueDeviceWork(async () => {
    const device = new ZKLib(config.ip, config.port, config.timeout, config.inport);
    let connected = false;

    try {
      await createSocketQuietly(device);
      connected = true;
      return await work(device, config);
    } catch (error) {
      error.publicMessage = connected
        ? `No se pudo completar la lectura del ZKTeco en ${config.ip}:${config.port}: ${error.message}`
        : `No se pudo conectar al ZKTeco ${config.model || ''} en ${config.ip}:${config.port}.`;
      throw error;
    } finally {
      try {
        await device.disconnect();
      } catch (_error) {
        // Some failed connection attempts leave no socket to close.
      }
    }
  });
}

async function createSocketQuietly(device) {
  const originalLog = console.log;
  console.log = (...args) => {
    const message = args.join(' ');
    if (message === 'ok tcp' || message === 'ok udp') {
      return;
    }
    originalLog(...args);
  };

  try {
    await device.createSocket();
  } finally {
    console.log = originalLog;
  }
}

async function readDeviceStatus(deviceConfig) {
  return withDevice(deviceConfig, async (device, config) => {
    const info = await safeRead(() => device.getInfo());
    const deviceTime = await safeRead(() => device.getTime());
    const deviceName = await safeRead(() => device.getDeviceName());
    const serialNumber = await safeRead(() => device.getSerialNumber());
    const firmware = await safeRead(() => device.getFirmware());

    return {
      ok: true,
      device: config,
      connectionType: device.connectionType || null,
      deviceInfo: info,
      deviceName,
      serialNumber,
      firmware,
      deviceTime: deviceTime ? coerceDate(deviceTime)?.toISOString() : null,
      checkedAt: new Date().toISOString(),
      mode: 'read-only',
    };
  });
}

async function readDeviceDiagnostics(deviceConfig) {
  const startedAt = Date.now();
  try {
    const status = await readDeviceStatus(deviceConfig);
    return {
      ...status,
      elapsedMs: Date.now() - startedAt,
      compatibility: {
        protocol: 'ZK local TCP/UDP',
        canReadByNetwork: true,
        expectedPort: status.device.port,
        note: 'Compatible mientras el equipo tenga Wi-Fi/red activa y permita conexion PC por protocolo ZK.',
      },
    };
  } catch (error) {
    return {
      ok: false,
      device: {
        ...getDeviceConfig(),
        ...deviceConfig,
      },
      elapsedMs: Date.now() - startedAt,
      message: error.publicMessage || error.message,
      detail: error.message,
      compatibility: {
        protocol: 'ZK local TCP/UDP',
        canReadByNetwork: false,
        expectedPort: Number(deviceConfig?.port || getDeviceConfig().port),
        note: 'Revise IP, Wi-Fi/VPN, puerto 4370, PC Connection y que el equipo no este solo en modo USB/ADMS.',
      },
    };
  }
}

function filterDuplicatePunches(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.employeeId}::${event.localDate}::${event.localTime}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function readAttendanceSnapshot(deviceConfig) {
  return withDevice(deviceConfig, async (device, config) => {
    const download = await downloadFromDevice(device, config);
    return db.transaction(() => {
      saveEmployees(config.id, download.employees);
      const currentEmployeeIds = new Set(download.employees.map(employee => employee.employeeId));
      const selectedEvents = config.currentUsersOnly === true
        ? download.events.filter(event => currentEmployeeIds.has(event.employeeId)) : download.events;
      addStoredEvents(config.id, selectedEvents, 'device');
      recordSyncSuccess(config.id, download.deviceInfo);
      return getSavedAttendance(config);
    })();
  });
}

async function downloadAttendanceSnapshot(deviceConfig) {
  return withDevice(deviceConfig, downloadFromDevice);
}

async function downloadFromDevice(device, config) {
  const deviceInfo = await safeRead(() => device.getInfo());
  const usersResult = await readUsersCompatible(device);
  const attendanceResult = await readAttendancesCompatible(device);
  if (usersResult?.err || attendanceResult?.err) throw (usersResult?.err || attendanceResult?.err);
  if ((attendanceResult?.data?.length || 0) < Number(deviceInfo?.logCounts || 0)) throw new Error('El equipo no entrego el historial completo.');
  const employees = normalizeEmployees(usersResult?.data || [], config.id);
  const currentIds = new Set(employees.map(employee => employee.employeeId));
  if (config.currentUsersOnly === true && deviceInfo?.userCounts != null &&
      currentIds.size !== Number(deviceInfo.userCounts)) throw new Error('El equipo no entrego el padron completo.');
  const historical = getEmployees(config.id).map(employee => ({ ...employee, devicePresent: false }));
  const events = normalizeEvents(attendanceResult?.data || [], buildEmployeeIndex([...historical, ...employees]));
  if (events.length !== attendanceResult.data.length) throw new Error('El historial contiene checadas con fechas o identidades invalidas.');
  return { device: config, deviceInfo, connectionType: device.connectionType, employees, events };
}

function normalizeStoredEvents(records, employeeIndex) {
  return records
    .map((record) => {
      const timestamp = coerceDate(record.timestamp);
      if (!timestamp) {
        return null;
      }

      const identity = resolveAttendanceIdentity(record, employeeIndex);
      if (!identity) return null;
      const { employee, employeeId, deviceUserId } = identity;
      const employeeName = employee?.name || cleanValue(record.employeeName) || `Colaborador ${employeeId || 'sin numero'}`;

      return {
        id: `${record.source || 'local'}-${employeeId}-${timestamp.getTime()}`,
        employeeId,
        employeeName,
        deviceUserId,
        uid: identity.uid,
        timestamp: timestamp.toISOString(),
        localDate: record.localDate || toDateKey(timestamp),
        localTime: record.localTime || toTimeKey(timestamp),
        sourceIp: cleanValue(record.source),
      };
    })
    .filter(Boolean);
}

async function readUsersCompatible(device) {
  if (device.connectionType === 'tcp') return readTcpUsers(device.zklibTcp);
  const result = await device.getUsers();
  if (!result) throw new Error('No se pudo descargar el listado de colaboradores.');
  return result;
}

async function readAttendancesCompatible(device) {
  if (device.connectionType === 'tcp') return readTcpAttendances(device.zklibTcp);
  const result = await device.getAttendances();
  if (!result) throw new Error('No se pudo descargar el historial de asistencias.');
  return result;
}

async function readTcpUsers(tcp) {
  await safeRead(() => tcp.freeData());
  const data = await readTcpPreparedData(tcp, REQUEST_DATA.GET_USERS);
  await safeRead(() => tcp.freeData());

  const USER_PACKET_SIZE = 72;
  let userData = validateRecordBuffer(data, USER_PACKET_SIZE);
  const users = [];

  while (userData.length >= USER_PACKET_SIZE) {
    users.push(decodeUserData72(userData.subarray(0, USER_PACKET_SIZE)));
    userData = userData.subarray(USER_PACKET_SIZE);
  }

  return { data: users, download: 'tcp-sequential' };
}

async function readTcpAttendances(tcp) {
  await safeRead(() => tcp.freeData());
  const data = await readTcpPreparedData(tcp, REQUEST_DATA.GET_ATTENDANCE_LOGS);
  await safeRead(() => tcp.freeData());

  const RECORD_PACKET_SIZE = 40;
  let recordData = validateRecordBuffer(data, RECORD_PACKET_SIZE);
  const records = [];

  while (recordData.length >= RECORD_PACKET_SIZE) {
    records.push({ ...decodeRecordData40(recordData.subarray(0, RECORD_PACKET_SIZE)), ip: tcp.ip });
    recordData = recordData.subarray(RECORD_PACKET_SIZE);
  }

  return { data: records, download: 'tcp-sequential' };
}

async function safeRead(read) {
  try {
    return await read();
  } catch (_error) {
    return null;
  }
}

function normalizeEmployees(users, deviceId) {
  const overrides = getEmployeeOverrides(deviceId);
  return users
    .map((user) => {
      const uid = cleanValue(user.uid);
      const userId = cleanValue(user.userId);
      const employeeId = userId || uid;
      const dbName = overrides[String(employeeId)];
      const name = dbName || cleanValue(user.name) || `Colaborador ${employeeId || uid}`;

      return {
        uid,
        employeeId,
        name,
        role: user.role ?? null,
        cardNo: cleanValue(user.cardno),
      };
    })
    .filter((employee) => employee.employeeId || employee.uid)
    .sort((a, b) => naturalCompare(a.employeeId, b.employeeId));
}

function normalizeEvents(records, employeeIndex) {
  return records
    .map((record) => {
      const timestamp = coerceDate(record.recordTime || record.attTime || record.timestamp);
      if (!timestamp) {
        return null;
      }

      const identity = resolveAttendanceIdentity(record, employeeIndex);
      if (!identity) return null;
      const { employee, employeeId, deviceUserId } = identity;
      const employeeName = employee?.name || `Colaborador ${employeeId || 'sin numero'}`;
      const localDate = toDateKey(timestamp);

      return {
        id: `${employeeId || deviceUserId}-${timestamp.getTime()}-${cleanValue(record.userSn)}`,
        employeeId,
        employeeName,
        deviceUserId,
        uid: identity.uid,
        identitySource: identity.identitySource,
        timestamp: timestamp.toISOString(),
        localDate,
        localTime: toTimeKey(timestamp),
        sourceIp: cleanValue(record.ip),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function filterEvents(events, filters) {
  const from = parseDateBoundary(filters.from, false);
  const to = parseDateBoundary(filters.to, true);
  const employeeId = cleanValue(filters.employeeId);

  return events.filter((event) => {
    const timestamp = coerceDate(event.timestamp);
    if (!timestamp) {
      return false;
    }
    if (from && timestamp < from) {
      return false;
    }
    if (to && timestamp > to) {
      return false;
    }
    if (employeeId && employeeId !== 'all' && cleanValue(event.employeeId) !== employeeId) {
      return false;
    }
    return true;
  });
}

function parseDateBoundary(value, endOfDay) {
  const parts = cleanValue(value).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  const [year, month, day] = parts;
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

function coerceDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toTimeKey(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function naturalCompare(left, right) {
  return cleanValue(left).localeCompare(cleanValue(right), 'es', {
    numeric: true,
    sensitivity: 'base',
  });
}

module.exports = {
  withDevice,
  getDeviceConfig,
  readDeviceStatus,
  readDeviceDiagnostics,
  readAttendanceSnapshot,
  downloadAttendanceSnapshot,
  filterEvents,
};
