const fs = require('node:fs');
const path = require('node:path');

// Source files were lost; update only the labels in the recovered compiled UI.
const assets = path.resolve(__dirname, '../dist/assets');
for (const name of fs.readdirSync(assets).filter(name => name.endsWith('.js'))) {
  const file = path.join(assets, name);
  const original = fs.readFileSync(file, 'utf8');
  const updated = original
    .replace('children:"Tolerancia"', 'children:"Tolerancia de entrada"')
    .replace('`Tolerancia: ${u.graceMinutes} min`', '`Tolerancia entrada: ${u.graceMinutes} min`');
  if (updated !== original) fs.writeFileSync(file, updated);
}
