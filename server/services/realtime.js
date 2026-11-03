const ZKLib = require('zklib-js');
const { addStoredEvents, getStoredEvents } = require('./eventStore');

const listeners = new Map();

async function startRealtime(deviceConfig) {
  const deviceId = String(deviceConfig.id || deviceConfig.ip);
  const existing = listeners.get(deviceId);
  if (existing?.active) {
    return getRealtimeStatus(deviceId);
  }

  const state = {
    active: false,
    connecting: true,
    deviceId,
    device: publicDevice(deviceConfig),
    startedAt: null,
    stoppedAt: null,
    lastEventAt: null,
    eventsCaptured: getStoredEvents(deviceId).length,
    error: null,
    zk: null,
  };
  listeners.set(deviceId, state);

  try {
    const zk = new ZKLib(
      deviceConfig.ip,
      Number(deviceConfig.port || 4370),
      Number(deviceConfig.timeout || 15000),
      Number(deviceConfig.inport || 4000),
    );
    state.zk = zk;
    await createSocketQuietly(zk);
    await zk.getRealTimeLogs((rawEvent) => {
      const normalized = normalizeRealtimeEvent(rawEvent);
      if (!normalized) {
        return;
      }
      const inserted = addStoredEvents(deviceId, [normalized], 'realtime');
      if (inserted.length) {
        state.lastEventAt = inserted[0].timestamp;
        state.eventsCaptured += inserted.length;
      }
    });

    state.active = true;
    state.connecting = false;
    state.startedAt = new Date().toISOString();
    state.stoppedAt = null;
    state.error = null;
    return getRealtimeStatus(deviceId);
  } catch (error) {
    state.connecting = false;
    state.active = false;
    state.error = error.message;
    try {
      await state.zk?.disconnect();
    } catch (_error) {
      // Ignore cleanup errors.
    }
    return getRealtimeStatus(deviceId);
  }
}

async function stopRealtime(deviceId) {
  const state = listeners.get(String(deviceId));
  if (!state) {
    return { active: false, deviceId: String(deviceId), eventsCaptured: 0 };
  }

  try {
    await state.zk?.disconnect();
  } catch (_error) {
    // Ignore cleanup errors.
  }

  state.active = false;
  state.connecting = false;
  state.stoppedAt = new Date().toISOString();
  return getRealtimeStatus(deviceId);
}

function getRealtimeStatus(deviceId) {
  const state = listeners.get(String(deviceId));
  if (!state) {
    return {
      active: false,
      deviceId: String(deviceId),
      eventsCaptured: getStoredEvents(deviceId).length,
    };
  }

  return {
    active: state.active,
    connecting: state.connecting,
    deviceId: state.deviceId,
    device: state.device,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    lastEventAt: state.lastEventAt,
    eventsCaptured: getStoredEvents(deviceId).length,
    error: state.error,
  };
}

function normalizeRealtimeEvent(rawEvent) {
  const userId = cleanValue(rawEvent?.userId || rawEvent?.deviceUserId || rawEvent?.userSn);
  const timestamp = coerceDate(rawEvent?.attTime || rawEvent?.recordTime || rawEvent?.timestamp);
  if (!userId || !timestamp) {
    return null;
  }

  return {
    employeeId: userId,
    deviceUserId: userId,
    timestamp,
  };
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

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    model: device.model,
    ip: device.ip,
    port: device.port,
  };
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

module.exports = {
  getRealtimeStatus,
  startRealtime,
  stopRealtime,
};
