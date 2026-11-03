const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const { COMMANDS: C } = require('zklib-js/constants');
const { createTCPHeader } = require('zklib-js/utils');
const { captureFingerprint, validateEnrollment, nextEmployeeId, commandChannel, readEnrollmentSnapshot } = require('./services/zkEnrollment');
const { createEnrollmentManager } = require('./services/enrollment');
const input = { employeeId: '20', fingerIndex: 3, createEmployee: false, consent: true, confirmed: true };
const existing = { uid: 6, employeeId: '20', name: 'Mauricio Blanquet', role: 0, cardNo: 0 };
function snapshot(extra = {}) {
  return { users: [existing], usersHash: 'users', userHashes: new Map([[6, 'user6']]), templates: new Map([['6:4', 'thumb']]), ...extra };
}
function fixture(settings = {}) {
  const controller = new AbortController();
  const reports = [], commands = [];
  const before = settings.before || snapshot();
  const after = settings.after || snapshot({ templates: new Map([['6:4', 'thumb'], ['6:3', 'index']]) });
  let reads = 0, time = 0;
  const channel = { close() {}, async send(code) {
    commands.push(code);
    if (settings.cleanupFails && code === C.CMD_STARTVERIFY) throw new Error('offline');
    const payload = Buffer.alloc(28);
    payload.writeUInt32LE(settings.noCounterChange ? before.templates.size : after.templates.size, 24);
    return { code: C.CMD_ACK_OK, payload };
  } };
  const options = { read: async () => { reads++; if (settings.verificationFails && reads > 1) throw new Error('offline'); return reads === 1 ? before : after; },
    open: () => channel, now: () => time, duration: 4000,
    sleep: async () => { time += 2000; if (settings.cancel) { controller.abort(); controller.signal.throwIfAborted(); } } };
  const run = () => captureFingerprint({}, input, { signal: controller.signal, report: value => reports.push(value) }, options);
  return { run, reports, commands, controller };
}

test('requires explicit confirmation, consent, a canonical ID and a valid finger', () => {
  assert.equal(validateEnrollment(input).employeeId, '20');
  for (const invalid of [{ consent: false }, { confirmed: false }, { fingerIndex: 10 }, { fingerIndex: '3' }, { employeeId: '020' }, { employeeId: '0' }, { employeeId: 'abc' }]) {
    assert.throws(() => validateEnrollment({ ...input, ...invalid }), error => error.statusCode === 400);
  }
  assert.throws(() => validateEnrollment({ ...input, createEmployee: true, name: '' }));
  assert.throws(() => validateEnrollment({ ...input, createEmployee: true, name: 'ñ'.repeat(13) }));
  const automatic = validateEnrollment({ ...input, employeeId: undefined, createEmployee: true, name: 'New employee' });
  assert.equal(automatic.employeeId, '');
  assert.equal(validateEnrollment({ ...input, employeeId: '999', createEmployee: true, name: 'New employee' }).employeeId, '');
});

test('automatic IDs advance past both device users and historical employee IDs', () => {
  assert.equal(nextEmployeeId([]), '1');
  assert.equal(nextEmployeeId([{ employeeId: '1' }, { employeeId: '20' }, { employeeId: '56' }]), '57');
  assert.equal(nextEmployeeId([{ employeeId: '20' }], ['610', '56', '0010']), '611');
  assert.equal(nextEmployeeId([{ employeeId: '20' }], ['archived-name']), '21');
  assert.throws(() => nextEmployeeId([{ employeeId: '999999999' }]), /limite/);
});

test('an accepted start is not success until the selected slot is stored and verified', async () => {
  const { run, commands, reports } = fixture();
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.normalModeRestored, true);
  assert.ok(commands.includes(C.CMD_STARTENROLL));
  assert.ok(commands.includes(C.CMD_CANCELCAPTURE));
  assert.ok(commands.includes(C.CMD_STARTVERIFY));
  assert.deepEqual(reports.filter(item => item.status).map(item => item.status), ['waiting', 'verifying']);
  assert.ok(reports[0].deadline);
});

test('an occupied finger is never replaced or put into enrollment mode', async () => {
  const { run, commands } = fixture({ before: snapshot({ templates: new Map([['6:3', 'occupied']]) }) });
  await assert.rejects(run(), /No se reemplazara/);
  assert.equal(commands.length, 0);
});

test('a nonexistent employee is never created implicitly', async () => {
  const { run, commands } = fixture({ before: snapshot({ users: [] }) });
  await assert.rejects(run(), /no existe/);
  assert.equal(commands.length, 0);
});

test('timeout without a stored template is reported honestly', async () => {
  const { run } = fixture({ after: snapshot(), noCounterChange: true });
  const result = await run();
  assert.equal(result.status, 'timeout');
  assert.equal(result.normalModeRestored, true);
});

test('cancellation restores the clock and verifies no fingerprint was saved', async () => {
  assert.equal((await fixture({ cancel: true, after: snapshot() }).run()).status, 'cancelled');
});

test('a capture that completed just before cancellation is reported as stored, not lost', async () => {
  assert.equal((await fixture({ cancel: true }).run()).status, 'completed');
});

test('changes to another fingerprint, unverifiable results, or failed cleanup require attention', async () => {
  const changed = snapshot({ templates: new Map([['6:4', 'changed'], ['6:3', 'new']]) });
  assert.equal((await fixture({ after: changed }).run()).status, 'needs_attention');
  assert.equal((await fixture({ verificationFails: true }).run()).status, 'needs_attention');
  const cleanup = await fixture({ cleanupFails: true }).run();
  assert.equal(cleanup.status, 'needs_attention');
  assert.equal(cleanup.normalModeRestored, false);
});

test('new employees are created as normal users and verified before capture', async () => {
  const old = { uid: 1, employeeId: '56', name: 'Existing', role: 14 };
  const before = snapshot({ users: [old], usersHash: 'old', userHashes: new Map([[1, 'old-user']]), templates: new Map([['1:0', 'old-print']]) });
  const added = snapshot({ users: [old, existing], userHashes: new Map([[1, 'old-user'], [6, 'new-user']]), templates: before.templates });
  // The next UID is selected on the clock, not accepted from a browser request.
  added.users = [old, { ...existing, uid: 2, employeeId: '101' }];
  added.userHashes = new Map([[1, 'old-user'], [2, 'new-user']]);
  const after = { ...added, templates: new Map([['1:0', 'old-print'], ['2:3', 'new-print']]) };
  let reads = 0;
  const device = { zklibTcp: { async executeCmd(command, payload) {
    assert.equal(command, C.CMD_USER_WRQ);
    assert.equal(payload[2], 0);
    assert.equal(payload.readUInt16LE(0), 2);
    assert.equal(payload.subarray(48).toString().split('\0')[0], '101');
    const reply = Buffer.alloc(8); reply.writeUInt16LE(C.CMD_ACK_OK); return reply;
  } } };
  const reports = [];
  const result = await captureFingerprint(device, { ...input, createEmployee: true, name: existing.name }, {
    signal: new AbortController().signal, report: value => reports.push(value),
  }, { read: async () => [before, added, after][reads++], sleep: async () => {}, reservedEmployeeIds: () => ['100'],
    open: () => ({ close() {}, async send(command, data) {
      if (command === C.CMD_STARTENROLL) assert.equal(data.subarray(0, 24).toString().split('\0')[0], '101');
      const payload = Buffer.alloc(28); payload.writeUInt32LE(2, 24); return { code: C.CMD_ACK_OK, payload };
    } }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.employeeCreated, true);
  assert.ok(reports.some(value => value.employeeCreated));
  assert.ok(reports.some(value => value.employeeId === '101'));
});

test('the command channel reconstructs split frames and releases listeners', async () => {
  const socket = new EventEmitter();
  socket.write = (packet, callback) => {
    callback?.();
    const response = createTCPHeader(C.CMD_ACK_OK, 1, packet.readUInt16LE(14) - 1, Buffer.alloc(0));
    queueMicrotask(() => { socket.emit('data', response.subarray(0, 5)); socket.emit('data', response.subarray(5)); });
  };
  const channel = commandChannel({ socket, sessionId: 1, replyId: 0 });
  assert.equal((await channel.send(C.CMD_STARTVERIFY)).code, C.CMD_ACK_OK);
  channel.close();
  assert.equal(socket.listenerCount('data'), 0);
  assert.equal(socket.listenerCount('error'), 0);
});

test('snapshot verifies device counters and keeps credentials and template bytes out of employee metadata', async () => {
  const users = Buffer.alloc(76);
  users.writeUInt32LE(72); users.writeUInt16LE(6, 4); users.write('secret', 7); users.write('Mauricio', 15); users.write('20', 52);
  const templates = Buffer.alloc(14);
  templates.writeUInt32LE(10); templates.writeUInt16LE(10, 4); templates.writeUInt16LE(6, 6); templates[8] = 3; templates[9] = 1;
  const socket = new EventEmitter();
  socket.write = (packet, callback) => {
    callback();
    const requested = packet.readUInt16LE(17);
    const payload = requested === 9 ? users : templates;
    queueMicrotask(() => socket.emit('data', createTCPHeader(C.CMD_DATA, 1, 1, payload)));
  };
  let fingers = 1;
  const device = { connectionType: 'tcp', getDeviceName: async () => 'F22\0',
    zklibTcp: { socket, sessionId: 1, replyId: 0, timeout: 100,
      freeData: async () => {}, executeCmd: async () => {
        const reply = Buffer.alloc(40); reply.writeUInt16LE(C.CMD_ACK_OK); reply.writeUInt32LE(1, 24); reply.writeUInt32LE(fingers, 32); return reply;
      } } };
  const snapshot = await readEnrollmentSnapshot(device);
  assert.equal(snapshot.templates.has('6:3'), true);
  assert.equal(snapshot.users[0].employeeId, '20');
  assert.ok(!JSON.stringify(snapshot.users).includes('secret'));
  fingers = 2;
  await assert.rejects(readEnrollmentSnapshot(device), /Listado de huellas incompleto/);
});

test('unsupported models and UDP never enter the enrollment protocol', async () => {
  await assert.rejects(readEnrollmentSnapshot({ connectionType: 'udp' }), /TCP/);
  await assert.rejects(readEnrollmentSnapshot({ connectionType: 'tcp', getDeviceName: async () => 'F18' }), /F22/);
});

const dbs = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function managerFixture(capture = async () => ({ status: 'completed', message: 'Verified', fingerprintStored: true }), overrides = {}) {
  const db = new Database(':memory:'); dbs.push(db);
  db.exec(`CREATE TABLE enrollment_jobs(id TEXT PRIMARY KEY,device_id TEXT,employee_id TEXT,finger_index INTEGER,
    actor_id TEXT,status TEXT,message TEXT,created_at TEXT,updated_at TEXT,finished_at TEXT,deadline TEXT,
    cancel_requested INTEGER DEFAULT 0,result TEXT)`);
  const devices = [{ id: 'a', ip: '127.0.0.1', port: 4370 }, { id: 'b', ip: '127.0.0.2', port: 4370 }];
  const deps = { db, withDevice: async (_device, work) => work({}), getDeviceById: id => devices.find(device => device.id === id),
    getRealtimeStatus: () => ({}), saveEmployees() {}, capture, ...overrides };
  return { db, devices, deps, manager: createEnrollmentManager(deps) };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('jobs are audited, survive reopening and cannot be read through another device', async () => {
  const { db, devices, manager, deps } = managerFixture();
  const job = manager.start(devices[0], 'admin', input);
  assert.equal(job.status, 'queued');
  await settled();
  assert.equal(manager.job(job.id, 'a').status, 'completed');
  assert.throws(() => manager.job(job.id, 'b'), error => error.statusCode === 404);
  assert.equal(db.prepare('SELECT actor_id FROM enrollment_jobs').get().actor_id, 'admin');
  assert.equal(createEnrollmentManager(deps).latest('a').status, 'completed');
  assert.ok(!JSON.stringify(manager.latest('a')).includes('templates'));
});

test('overlapping jobs on one clock are rejected and cancellation is persistent', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { devices, manager } = managerFixture(async (_device, _input, control) => {
    await gate;
    return { status: control.signal.aborted ? 'cancelled' : 'completed', message: 'Done' };
  });
  const job = manager.start(devices[0], 'admin', input);
  assert.throws(() => manager.start(devices[0], 'admin', input), error => error.statusCode === 409);
  await settled();
  assert.equal(manager.cancel(job.id, 'a', 'admin').cancelRequested, true);
  release(); await settled();
  assert.equal(manager.job(job.id, 'a').status, 'cancelled');
  assert.equal(manager.isBusy('a'), false);
});

test('queued cancellation and changed device configuration never begin capture', async () => {
  let calls = 0;
  const { devices, manager } = managerFixture(async () => { calls++; });
  const job = manager.start(devices[0], 'admin', input);
  manager.cancel(job.id, 'a', 'admin'); await settled();
  assert.equal(calls, 0);
  assert.equal(manager.job(job.id, 'a').status, 'cancelled');
});

test('recovering an unfinished audit requires review rather than claiming success', async () => {
  const { db, deps } = managerFixture();
  db.exec("INSERT INTO enrollment_jobs(id,device_id,status,message,created_at,updated_at) VALUES ('old','a','waiting','waiting','old','old')");
  const manager = createEnrollmentManager(deps);
  assert.equal(manager.job('old', 'a').status, 'needs_attention');
  assert.ok(manager.job('old', 'a').finishedAt);
});

test('preview calculates IDs using only users and the selected device history', async () => {
  const { manager, devices } = managerFixture(undefined, {
    readUsers: async () => ({ users: [{ employeeId: '20' }] }),
    read: async () => { throw new Error('Fingerprint data must not be requested'); },
    reservedEmployeeIds: id => id === 'a' ? ['610'] : ['80'],
  });
  assert.deepEqual(await manager.nextEmployee(devices[0]), { employeeId: '611' });
  assert.deepEqual(await manager.nextEmployee(devices[1]), { employeeId: '81' });
});

test('queued new users ignore browser-supplied IDs and audit the ID assigned during capture', async () => {
  const { manager, devices } = managerFixture(async (_device, request, control) => {
    assert.equal(request.employeeId, '');
    control.report({ employeeId: '611' });
    return { status: 'completed', message: 'Verified', fingerprintStored: true, employeeCreated: true };
  });
  const job = manager.start(devices[0], 'admin', { ...input, employeeId: '20', createEmployee: true, name: 'New employee' });
  assert.equal(job.employeeId, '');
  await settled();
  assert.equal(manager.job(job.id, 'a').employeeId, '611');
  assert.equal(manager.job(job.id, 'a').status, 'completed');
});
