const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, 'data');
for (const [before, after] of [['devices.json', 'devices.db'], ['employee-names.json', 'employee_overrides.db']]) {
  if (!fs.existsSync(path.join(dir, after)) && fs.existsSync(path.join(dir, before))) {
    fs.copyFileSync(path.join(dir, before), path.join(dir, after));
    fs.chmodSync(path.join(dir, after), 0o600);
  }
}
require('./services/auth').getUsers();
const { addStoredEvents } = require('./services/eventStore');
let inserted = 0;
for (const file of fs.readdirSync(dir).filter(f => /^snapshot-.*\.json$/.test(f))) {
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  inserted += addStoredEvents(snapshot.device.id, snapshot.events, 'recovered-snapshot').length;
}
console.log('Migrated events:', inserted);
