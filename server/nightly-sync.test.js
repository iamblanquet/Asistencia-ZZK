const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { dueDay, createNightlyRunner, startNightlySync } = require('./services/nightlySync');
const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const silent = { info() {}, warn() {}, error() {} };
function fixture(overrides = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE nightly_sync_runs(day TEXT PRIMARY KEY, started_at TEXT NOT NULL,
    finished_at TEXT,status TEXT NOT NULL,results TEXT NOT NULL)`);
  const calls = [];
  const sleeps = [];
  const runner = createNightlyRunner({ db, log: silent,
    now: () => new Date('2026-11-04T06:00:00Z'),
    getDevices: () => [{ id: 'a' }, { id: 'b' }],
    syncAttendance: async device => { calls.push(device.id); return { fetchedAt: 'now', events: [1, 2] }; },
    sleep: async ms => { sleeps.push(ms); }, ...overrides });
  return { db, runner, calls, sleeps };
}

test('daily cutoff is 23:59 in Mexico City, independent of server timezone', () => {
  assert.equal(dueDay(new Date('2026-11-04T05:58:59Z')), '2026-11-02');
  assert.equal(dueDay(new Date('2026-11-04T05:59:00Z')), '2026-11-03');
  assert.equal(dueDay(new Date('2026-11-04T06:01:00Z')), '2026-11-03');
  assert.equal(dueDay(new Date('2026-11-01T12:00:00Z')), '2026-10-31');
});

test('synchronizes all current devices and durably records results', async () => {
  const { db, runner, calls } = fixture();
  const result = await runner.run();
  assert.equal(result.day, '2026-11-03');
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['a', 'b']);
  const saved = db.prepare('SELECT * FROM nightly_sync_runs').get();
  assert.ok(saved.finished_at);
  assert.equal(JSON.parse(saved.results).length, 2);
  assert.equal((await runner.run()).skipped, true);
  assert.equal(calls.length, 2);
});

test('retries failures three times, retains a partial outcome and continues to other devices', async () => {
  const calls = [];
  const { db, runner, sleeps } = fixture({ syncAttendance: async device => {
    calls.push(device.id);
    if (device.id === 'a') throw new Error('offline');
    return { fetchedAt: 'now', events: [] };
  } });
  const result = await runner.run();
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls, ['a', 'a', 'a', 'b']);
  assert.deepEqual(sleeps, [30000, 30000]);
  assert.equal(result.results[0].attempts, 3);
  assert.equal(result.results[1].ok, true);
  assert.equal(db.prepare('SELECT status FROM nightly_sync_runs').get().status, 'partial');
});

test('recovers from a transient failure on a subsequent attempt', async () => {
  let calls = 0;
  const { runner } = fixture({ getDevices: () => [{ id: 'a' }], syncAttendance: async () => {
    if (++calls === 1) throw new Error('temporary');
    return { fetchedAt: 'now', events: [] };
  } });
  const result = await runner.run();
  assert.equal(result.status, 'success');
  assert.equal(result.results[0].attempts, 2);
});

test('shares the running job instead of launching overlapping jobs', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { runner } = fixture({ syncAttendance: async () => { await wait; return { events: [] }; } });
  const first = runner.run();
  assert.equal(first, runner.run());
  release();
  assert.equal((await first).status, 'success');
});

test('an interrupted job is recovered at the next startup', async () => {
  const { db, runner, calls } = fixture();
  db.prepare("INSERT INTO nightly_sync_runs VALUES (?,'old',NULL,'running','[]')").run('2026-11-03');
  assert.equal((await runner.run()).status, 'success');
  assert.deepEqual(calls, ['a', 'b']);
});

test('a general failure is persisted and does not block future runs', async () => {
  let unavailable = true;
  const { db, runner } = fixture({ getDevices: () => { if (unavailable) throw new Error('database unavailable'); return []; } });
  await assert.rejects(runner.run(), /database unavailable/);
  assert.equal(db.prepare('SELECT status FROM nightly_sync_runs').get().status, 'failed');
  unavailable = false;
  assert.equal((await runner.run()).status, 'success');
});

test('startup registers the timezone-aware cron and checks missed synchronization', async () => {
  let registered, calls = 0;
  const task = {};
  const result = startNightlySync({ log: silent,
    runner: { run: async () => { calls++; } },
    cron: { schedule(expression, callback, options) { registered = { expression, callback, options }; return task; } },
  });
  assert.equal(result, task);
  assert.equal(registered.expression, '59 23 * * *');
  assert.equal(registered.options.timezone, 'America/Mexico_City');
  assert.equal(registered.options.noOverlap, true);
  assert.equal(calls, 1);
  await registered.callback();
  assert.equal(calls, 2);
});
