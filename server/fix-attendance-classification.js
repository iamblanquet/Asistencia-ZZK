const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../dist/assets/index-DyCXu5bn.js');
let code = fs.readFileSync(file, 'utf8');
const changes = [
  ['E=S>v,N=y?', 'E=y&&S>v,N=y?'],
  ['let Z=0,we=0,Qe=0,et=0;Gr.forEach(_r=>{_r.isEarlyLeave&&_r.isLate?(we++,Qe++):_r.isLate?we++:_r.isEarlyLeave?Qe++:_r.isIncomplete?et++:Z++});const on=Z+we+Qe+et||1', 'let Z=0,we=0,Qe=0,et=0,both=0;Gr.forEach(_r=>{_r.isIncomplete?et++:_r.isEarlyLeave&&_r.isLate?both++:_r.isLate?we++:_r.isEarlyLeave?Qe++:Z++});const on=Z+we+Qe+et+both||1'],
  ['{name:"A tempo",value:Z', '{name:"A tiempo",value:Z'],
  ['{name:"Incompleto",value:et,percentage:yn(et),color:"#ffde73"}', '{name:"Incompleto",value:et,percentage:yn(et),color:"#ffde73"},{name:"Retardo + S. temprana",value:both,percentage:yn(both),color:"#f59e0b"}'],
];
for (const [before, after] of changes) {
  if (code.includes(after)) continue;
  if (!code.includes(before)) throw new Error('Compiled UI changed; review replacement: ' + before);
  code = code.replace(before, after);
}
fs.writeFileSync(file, code);
