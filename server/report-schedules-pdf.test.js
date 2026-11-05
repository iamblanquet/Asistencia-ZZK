const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('@babel/parser');
const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');

test('employee PDF prints the actual group, hours and entry grace for each historic day', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8');
  const functions = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body
    .filter(node => node.type === 'FunctionDeclaration' && ['drawAsistoPdfBrand', 'drawEmployeePage'].includes(node.id.name))
    .map(node => source.slice(node.start, node.end)).join('\n');
  const helperSource = fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8');
  const helpers = await import('data:text/javascript;base64,' + Buffer.from(helperSource).toString('base64'));
  const general = { shiftStart: '08:00', shiftEnd: '17:00', satShiftStart: '08:00', satShiftEnd: '13:00', graceMinutes: 10 };
  const schedule = { ...general, generalReportSchedule: { revision: 2, versions: [
    { effectiveFrom: '0001-01-01', settings: general },
    { effectiveFrom: '2026-11-03', settings: { ...general, shiftStart: '08:15', shiftEnd: '17:15', graceMinutes: 20 } },
  ] }, reportScheduleGroups: [{ id: 'early', name: 'Horario temprano de operaciones y personal administrativo', versions: [
    { effectiveFrom: '2026-11-04', settings: { ...general, shiftStart: '07:00', shiftEnd: '16:00', graceMinutes: 15 } },
  ] }] };
  const employees = [{ employeeId: '1', name: 'Colaborador de prueba', scheduleAssignments: [{ effectiveFrom: '2026-11-04', groupId: 'early' }] }];
  const punches = Array.from({ length: 14 }, (_, i) => helpers.addDays('2026-11-01', i)).flatMap(date =>
    ['07:10', '16:50'].map(time => ({ employeeId: '1', timestamp: `${date}T${time}:00` })));
  const rows = helpers.buildDailySummary(punches, employees, schedule);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  let table;
  const texts = [];
  const originalText = doc.text.bind(doc);
  doc.text = (value, ...args) => { texts.push(String(value)); return originalText(value, ...args); };
  const asistoPdfLogo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../src/assets/asisto-logo-pdf.png')).toString('base64');
  const context = vm.createContext({ ...helpers, asistoPdfLogo, autoTable: (pdf, options) => { table = options; autoTable(pdf, options); } });
  vm.runInContext(functions, context);
  context.drawEmployeePage(doc, { employeeId: '1', employeeName: employees[0].name, empRows: rows,
    empTotal: helpers.buildEmployeeTotals(rows)[0], range: { from: '2026-11-01', to: '2026-11-14' }, schedule,
    device: { ip: '127.0.0.1', port: 4370, name: 'Pruebas' } });
  assert.equal(table.head[0].length, 12);
  assert.equal(table.body.length, 14);
  assert.equal(table.body[0][1], 'Horario general\n08:00 - 17:00');
  assert.equal(table.body[0][2], '10 min');
  assert.equal(table.body[2][1], 'Horario general\n08:15 - 17:15');
  assert.equal(table.body[2][2], '20 min');
  assert.equal(table.body[3][1], schedule.reportScheduleGroups[0].name + '\n07:00 - 16:00');
  assert.equal(table.body[3][2], '15 min');
  assert.ok(doc.lastAutoTable.columns.every(column => column.width > 0));
  assert.ok(doc.lastAutoTable.columns.reduce((sum, column) => sum + column.width, 0) <= 713);
  assert.ok(doc.output().startsWith('%PDF-'));
  assert.equal(texts.some(value => /CONFIGURACI.N DEL REPORTE|Biom.trico IP|Horario y tolerancia:|Tolerancia aplicada solo/.test(value)), false);
  assert.equal(Object.keys(doc.internal.collections.addImage_images).length, 1);
  assert.equal(doc.getImageProperties(asistoPdfLogo).width, 1304);
  assert.equal(texts.some(value => /By ITZ|OIL & GAS/i.test(value)), false);
  if (process.env.ASISTENCIA_QA_PDF) doc.save(process.env.ASISTENCIA_QA_PDF);
});

test('summary and employee directory embed the same corporate logo without drawing a replacement wordmark', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const functions = ast.program.body.filter(node => node.type === 'FunctionDeclaration'
    && ['drawAsistoPdfBrand', 'drawSummaryPage'].includes(node.id.name));
  const app = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'App');
  functions.push(app.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'downloadEmployeeList'));
  const helpers = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8')).toString('base64'));
  const asistoPdfLogo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../src/assets/asisto-logo-pdf.png')).toString('base64');
  let directory;
  const context = vm.createContext({ ...helpers, asistoPdfLogo, autoTable,
    employees: [{ employeeId: '1', name: 'Colaborador de prueba', role: 0, cardNo: '', devicePresent: true }],
    device: { name: 'Pruebas', ip: '127.0.0.1', port: 4370 },
    jsPDF: function (options) { directory = new jsPDF(options); directory.save = () => directory; return directory; },
  });
  vm.runInContext(functions.map(node => source.slice(node.start, node.end)).join('\n'), context);
  context.downloadEmployeeList();
  assert.equal(Object.keys(directory.internal.collections.addImage_images).length, 1);
  const summary = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  context.drawSummaryPage(summary, { totals: [{ employeeId: '1', employeeName: 'Colaborador de prueba', days: 14,
    workedMinutes: 5040, lateCount: 0, lateMinutes: 0, earlyLeaveCount: 0, overtimeMinutes: 60, incompleteDays: 0 }],
  range: { from: '2026-11-01', to: '2026-11-14' }, device: context.device });
  assert.equal(Object.keys(summary.internal.collections.addImage_images).length, 1);
  if (process.env.ASISTENCIA_QA_PDF_SUMMARY) summary.save(process.env.ASISTENCIA_QA_PDF_SUMMARY);
  if (process.env.ASISTENCIA_QA_PDF_DIRECTORY) fs.writeFileSync(process.env.ASISTENCIA_QA_PDF_DIRECTORY, Buffer.from(directory.output('arraybuffer')));
});

test('Sunday PDF shows unscheduled work and the effective Sunday hours without null placeholders', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8');
  const functions = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body
    .filter(node => node.type === 'FunctionDeclaration' && ['drawAsistoPdfBrand', 'drawEmployeePage'].includes(node.id.name))
    .map(node => source.slice(node.start, node.end)).join('\n');
  const helpers = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../src/utils/attendance.js'), 'utf8')).toString('base64'));
  const base = { shiftStart: '08:00', shiftEnd: '17:00', satShiftStart: '08:00', satShiftEnd: '13:00', graceMinutes: 15, sundayEnabled: false };
  const schedule = { ...base, generalReportSchedule: { versions: [
    { effectiveFrom: '0001-01-01', settings: base },
    { effectiveFrom: '2026-11-08', settings: { ...base, sundayEnabled: true, sunShiftStart: '07:00', sunShiftEnd: '12:00' } },
  ] } };
  const rows = helpers.buildDailySummary(['2026-11-01', '2026-11-08'].flatMap(date => ['07:10', '12:50']
    .map(time => ({ employeeId: '1', timestamp: `${date}T${time}` }))), [{ employeeId: '1', name: 'Colaborador de prueba' }], schedule);
  let table;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
  const context = vm.createContext({ ...helpers,
    asistoPdfLogo: 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../src/assets/asisto-logo-pdf.png')).toString('base64'),
    autoTable: (pdf, options) => { table = options; autoTable(pdf, options); },
  });
  vm.runInContext(functions, context);
  context.drawEmployeePage(doc, { employeeId: '1', employeeName: 'Colaborador de prueba', empRows: rows,
    empTotal: helpers.buildEmployeeTotals(rows)[0], range: { from: '2026-11-01', to: '2026-11-08' }, schedule, device: { name: 'Pruebas', ip: '127.0.0.1' } });
  assert.equal(table.body[0][1], 'Horario general\nSin horario');
  assert.equal(table.body[0][2], '-');
  assert.equal(table.body[0][5], '05:40');
  assert.equal(table.body[0][10], '00:00');
  assert.equal(table.body[0][11], 'Sin horario');
  assert.equal(table.body[1][1], 'Horario general\n07:00 - 12:00');
  assert.equal(table.body[1][2], '15 min');
  assert.equal(table.body[1][10], '01:00');
  assert.equal(JSON.stringify(table.body).includes('null'), false);
  if (process.env.ASISTENCIA_QA_PDF_SUNDAY) doc.save(process.env.ASISTENCIA_QA_PDF_SUNDAY);
});
