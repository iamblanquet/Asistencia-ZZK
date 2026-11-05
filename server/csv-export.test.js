const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const { zip, unzipSync, strToU8 } = require('fflate');

const root = path.join(__dirname, '..');
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const attendanceUrl = moduleUrl(fs.readFileSync(path.join(root, 'src/utils/attendance.js'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src/utils/csv.js'), 'utf8');
const dependency = parse(source, { sourceType: 'module' }).program.body.find(node => node.type === 'ImportDeclaration').source;
const csvUrl = moduleUrl(source.slice(0, dependency.start) + JSON.stringify(attendanceUrl) + source.slice(dependency.end));
const helpers = import(attendanceUrl);
const exportsModule = import(csvUrl);
const device = { id: 'base-peru', name: 'Base Peru', ip: '172.26.10.136' };
const range = { from: '2026-11-02', to: '2026-11-04' };
const settings = { shiftStart: '08:00', shiftEnd: '17:00', graceMinutes: 15 };

test('CSV quotes text, preserves accents and newlines, uses UTF-8 BOM and CRLF', async () => {
  const { encodeCsv } = await exportsModule;
  assert.equal(encodeCsv([['Nombre', 'Comentario'], ['Peru, Mexico', 'Dice "si"\nMauricio'], ['José', null]]),
    '\uFEFF"Nombre","Comentario"\r\n"Peru, Mexico","Dice ""si""\nMauricio"\r\n"José",""\r\n');
});

test('CSV neutralizes spreadsheet formulas including control prefixes without changing numeric values', async () => {
  const { encodeCsv } = await exportsModule;
  for (const text of ['=1+1', '+CMD()', '-CMD()', '@SUM(A1)', '  =1', '\t=1', '\r=1', '\n=1']) {
    assert.equal(encodeCsv([[text]]), '\uFEFF"\'' + text + '"\r\n');
  }
  assert.equal(encodeCsv([[-20, 0, 'A\0B']]), '\uFEFF"-20","0","AB"\r\n');
});

test('detailed attendance exports the same historic schedule, grace and daily overtime calculations', async () => {
  const { buildDailySummary, buildEmployeeTotals } = await helpers;
  const { attendanceCsv, totalsCsv } = await exportsModule;
  const employees = [{ employeeId: '20', name: 'Mauricio', scheduleAssignments: [{ effectiveFrom: '2026-11-04', groupId: 'early' }] }];
  const schedule = { ...settings, reportScheduleGroups: [{ id: 'early', name: 'Temprano', versions: [
    { effectiveFrom: '2026-11-04', settings: { ...settings, shiftStart: '07:00', shiftEnd: '16:00' } },
  ] }] };
  const events = ['2026-11-02T08:10', '2026-11-02T08:12', '2026-11-02T17:20',
    '2026-11-03T08:00', '2026-11-03T17:20', '2026-11-04T07:10', '2026-11-04T16:50']
    .map(timestamp => ({ employeeId: '20', timestamp }));
  const rows = buildDailySummary(events, employees, schedule);
  assert.deepEqual(rows.map(row => row.overtimeMinutes), [0, 0, 60]);
  assert.equal(rows[0].duplicatePunchCount, 1);
  assert.equal(rows[0].isLate, false);
  const csv = attendanceCsv(rows, device, range);
  assert.match(csv, /"ID colaborador","Colaborador"/);
  assert.match(csv, /"Horario general","08:00","17:00","15"/);
  assert.match(csv, /"Temprano","07:00","16:00","15"/);
  assert.match(csv, /"No","0","No","0","01:00","60"/);
  assert.equal(csv.split('\r\n').length, 5);
  assert.equal((csv.match(/"base-peru"/g) || []).length, 3);
  assert.ok(csv.includes(new Date(events[0].timestamp).toISOString()));
  const total = totalsCsv(buildEmployeeTotals(rows), device, range);
  assert.match(total, /"Mauricio","3"/);
  assert.match(total, /"01:00","60","0"/);
});

test('directory CSV excludes historical-only collaborators, applies search and retains stored card data', async () => {
  const { employeesCsv } = await exportsModule;
  const roster = [{ employeeId: '20', name: 'Mauricio', role: 0, cardNo: '0002', uid: 6, scheduleName: 'Temprano' },
    { employeeId: '21', name: 'Historico', devicePresent: false }, { employeeId: '22', name: 'Otro', role: 14 }];
  const csv = employeesCsv(roster, device, '2026-11-04', 'mauricio');
  assert.match(csv, /"20","Mauricio","Usuario normal","0002","6","Temprano"/);
  assert.equal(csv.includes('Historico'), false);
  assert.equal(csv.includes('Otro'), false);
  assert.equal(csv.includes('172.26.10.136'), true);
  assert.equal(csv.split('\r\n').length, 3);
});

test('event CSV preserves calendar dates, timestamps and classified event types', async () => {
  const { eventsCsv } = await exportsModule;
  const csv = eventsCsv([{ employeeId: '20', employeeName: 'Mauricio', localDate: '2026-11-04', localTime: '08:00',
    timestamp: '2026-11-04T08:00:00-06:00', eventType: 'Entrada', source: 'tcp', uid: 6 }], device, range);
  assert.match(csv, /"2026-11-04","08:00","2026-11-04T14:00:00.000Z","20","Mauricio","Entrada","tcp","","6"/);
});

test('Sunday CSV distinguishes unplanned work from a scheduled Sunday without losing punches', async () => {
  const { buildDailySummary } = await helpers;
  const { attendanceCsv } = await exportsModule;
  const events = ['09:00', '13:50'].map(time => ({ employeeId: '20', timestamp: `2026-11-08T${time}` }));
  const rows = buildDailySummary(events, [{ employeeId: '20', name: 'Mauricio' }], { ...settings, sundayEnabled: false });
  const csv = attendanceCsv(rows, device, { from: '2026-11-08', to: '2026-11-08' });
  assert.match(csv, /"Jornada programada"/);
  assert.match(csv, /"Horario general","","","0"/);
  assert.match(csv, /"04:50","290","0","No","0","No","0","00:00","0","Sin horario"/);
  assert.ok(csv.endsWith(',"No"\r\n'));
});

test('per-collaborator ZIP round-trips UTF-8 and prevents colliding or path-like filenames', async () => {
  const { buildDailySummary, buildEmployeeTotals } = await helpers;
  const { employeeCsvFiles, totalsCsv, exportFilePart } = await exportsModule;
  const rows = buildDailySummary([{ employeeId: 'a/b', timestamp: '2026-11-04T08:00' },
    { employeeId: 'a?b', timestamp: '2026-11-04T08:00' }], [
    { employeeId: 'a/b', name: '../../José' }, { employeeId: 'a?b', name: '../../José' },
  ], settings);
  const files = employeeCsvFiles(rows, device, range);
  assert.equal(new Set(files.map(file => file.filename)).size, 2);
  assert.equal(exportFilePart('../../José'), 'Jose');
  assert.ok(files.every(file => /^[a-zA-Z0-9_-]+\.csv$/.test(file.filename)));
  const content = Object.fromEntries(files.map(file => [file.filename, strToU8(file.content)]));
  content['resumen-general.csv'] = strToU8(totalsCsv(buildEmployeeTotals(rows), device, range));
  const archive = await new Promise((resolve, reject) => zip(content, { level: 6 }, (error, value) => error ? reject(error) : resolve(value)));
  const restored = unzipSync(archive);
  assert.equal(Object.keys(restored).length, 3);
  for (const file of files) {
    assert.equal(Buffer.from(restored[file.filename]).toString('utf8'), file.content);
    assert.equal(file.content.split('\r\n').length, 3);
  }
});

test('Spanish user-facing source consistently says colaboradores and directory UI omits the card column', () => {
  const app = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  const directoryStart = app.indexOf('Personal Registrado');
  const directory = app.slice(directoryStart, app.indexOf("{activeTab === 'usuarios'", directoryStart));
  assert.equal(/No\. Tarjeta|cardNo/.test(directory), false);
  assert.match(directory, /colSpan=\{5\}/);
  function check(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (['data', 'node_modules'].includes(entry.name)) continue;
      const filename = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) check(filename);
      else if (/\.(jsx?|css)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
        assert.equal(/emplead[oa]s?/i.test(fs.readFileSync(filename, 'utf8')), false, filename);
      }
    }
  }
  check(path.join(root, 'src'));
  check(path.join(root, 'server'));
});

async function runReport(overrides = {}) {
  const appSource = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  const app = parse(appSource, { sourceType: 'module', plugins: ['jsx'] }).program.body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'App');
  const report = app.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'downloadReport');
  const requests = [], downloads = [], errors = [];
  const employees = [{ employeeId: '3', name: 'Juan' }, { employeeId: '20', name: 'Mauricio' }];
  const events = employees.flatMap(employee => ['08:00', '17:50'].map(time => ({
    employeeId: employee.employeeId, timestamp: `2026-11-04T${time}:00`,
  })));
  const context = vm.createContext({ ...await helpers, ...await exportsModule, URLSearchParams,
    activeTab: 'general', selectedEmployee: '3', employeeQuery: 'juan', attendanceStatus: 'Retardo',
    attendanceDescending: false, range, activeDeviceId: device.id, device, initialSchedule: settings,
    setDownloading() {}, setError(value) { if (value) errors.push(value); },
    getJson: async url => { requests.push(url); return { device: { ...device, ...settings }, employees, events }; },
    saveExport: (...args) => downloads.push(args), ...overrides,
  });
  vm.runInContext(appSource.slice(report.start, report.end), context);
  await context.downloadReport('consolidated', 'csv');
  return { requests, downloads, errors };
}

test('quick period report ignores collaborator and status filters retained from another view', async () => {
  const { requests, downloads, errors } = await runReport();
  assert.equal(errors.length, 0);
  assert.equal(new URL(requests[0], 'http://localhost').searchParams.has('employeeId'), false);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0][0], /"Juan"/);
  assert.match(downloads[0][0], /"Mauricio"/);
});

test('attendance CSV respects current collaborator, search and status filters', async () => {
  const { requests, downloads, errors } = await runReport({ activeTab: 'asistencias', attendanceStatus: 'A tiempo' });
  assert.equal(errors.length, 0);
  assert.equal(new URL(requests[0], 'http://localhost').searchParams.get('employeeId'), '3');
  assert.match(downloads[0][0], /"Juan"/);
  assert.equal(downloads[0][0].includes('Mauricio'), false);
});

test('exports reject a response belonging to another biometric device', async () => {
  const { downloads, errors } = await runReport({ getJson: async () => ({ device: { id: 'other' }, employees: [], events: [] }) });
  assert.equal(downloads.length, 0);
  assert.match(errors[0], /no corresponde al biometrico/);
});
