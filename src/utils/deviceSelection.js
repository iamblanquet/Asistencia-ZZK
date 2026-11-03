export function preferredDevice(devices, userId, storage) {
  let savedId = null;
  try {
    if (userId) savedId = storage.getItem(`asisto-device:${userId}`);
  } catch {
    // Browser preferences are optional when storage is blocked.
  }
  return devices.find(device => device.id === savedId) || devices[0] || null;
}

export function rememberDevice(deviceId, userId, storage) {
  if (!deviceId || !userId) return;
  try {
    storage.setItem(`asisto-device:${userId}`, deviceId);
  } catch {
    // Keep the current session usable without persistent browser storage.
  }
}
