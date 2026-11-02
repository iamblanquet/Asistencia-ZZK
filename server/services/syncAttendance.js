const { readAttendanceSnapshot } = require('./zkteco');
const { recordSyncAttempt, recordSyncFailure } = require('./attendanceStore');
const pending = new Map();

function syncAttendance(device) {
  if (pending.has(device.id)) return pending.get(device.id);
  const work = Promise.resolve().then(async () => {
    recordSyncAttempt(device.id);
    try { return await readAttendanceSnapshot(device); }
    catch (error) { recordSyncFailure(device.id, error); throw error; }
  }).finally(() => pending.delete(device.id));
  pending.set(device.id, work);
  return work;
}
module.exports = { syncAttendance };
