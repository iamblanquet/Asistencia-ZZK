const TIMEZONE = 'America/Mexico_City';
const EXPRESSION = '59 23 * * *';

function dueDay(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) * 60 + Number(parts.minute) < 23 * 60 + 59) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function createNightlyRunner({ db, getDevices, syncAttendance, log = console,
  now = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let pending = null;
  const find = db.prepare('SELECT status FROM nightly_sync_runs WHERE day=?');
  const start = db.prepare(`INSERT INTO nightly_sync_runs(day,started_at,status,results) VALUES (?,?,'running','[]')
    ON CONFLICT(day) DO UPDATE SET started_at=excluded.started_at,finished_at=NULL,status='running',results='[]'`);
  const progress = db.prepare('UPDATE nightly_sync_runs SET results=? WHERE day=?');
  const finish = db.prepare('UPDATE nightly_sync_runs SET status=?,finished_at=?,results=? WHERE day=?');
  return {
    run(day = dueDay(now())) {
      if (pending) return pending;
      pending = Promise.resolve().then(async () => {
        if (find.get(day)?.status === 'success') return { day, skipped: true };
        start.run(day, now().toISOString());
        const results = [];
        log.info(`[nightly-sync] Inicio ${day} (${TIMEZONE})`);
        try {
          for (const device of getDevices()) {
            let result;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const snapshot = await syncAttendance(device);
                result = { deviceId: device.id, ok: true, attempts: attempt,
                  fetchedAt: snapshot.fetchedAt, savedEvents: snapshot.events.length };
                break;
              } catch (error) {
                result = { deviceId: device.id, ok: false, attempts: attempt,
                  error: error.publicMessage || error.message || String(error) };
                log.warn(`[nightly-sync] ${device.id}, intento ${attempt}: ${result.error}`);
                if (attempt < 3) await sleep(30000);
              }
            }
            results.push(result);
            progress.run(JSON.stringify(results), day);
            log.info(`[nightly-sync] Dispositivo ${JSON.stringify(result)}`);
          }
          const status = results.every(result => result.ok) ? 'success' : 'partial';
          finish.run(status, now().toISOString(), JSON.stringify(results), day);
          log.info(`[nightly-sync] Fin ${day}: ${status}`);
          return { day, status, results };
        } catch (error) {
          finish.run('failed', now().toISOString(), JSON.stringify([...results, { error: error.message }]), day);
          throw error;
        }
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

function startNightlySync({ runner, cron = require('node-cron'), log = console } = {}) {
  if (!runner) {
    const { db } = require('./sqlite');
    const { getDevices } = require('./db');
    const { syncAttendance } = require('./syncAttendance');
    runner = createNightlyRunner({ db, getDevices, syncAttendance, log });
  }
  const execute = () => runner.run().catch(error => log.error(`[nightly-sync] Fallo general: ${error.message}`));
  const task = cron.schedule(EXPRESSION, execute, {
    timezone: TIMEZONE, noOverlap: true, name: 'asisto-nightly-sync', missedExecutionTolerance: 5 * 60000,
  });
  log.info(`[nightly-sync] Programado: ${EXPRESSION}, ${TIMEZONE}`);
  // A full download also recovers earlier days after downtime, without duplicating rows.
  void execute();
  return task;
}

module.exports = { TIMEZONE, EXPRESSION, dueDay, createNightlyRunner, startNightlySync };
