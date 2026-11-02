const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../dist/assets/index-BNk1tEoc.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

const lineIndex = 141 - 1; // 1-indexed to 0-indexed
const targetLine = lines[lineIndex];

if (!targetLine) {
  console.log(`Line ${lineIndex + 1} not found.`);
  process.exit(0);
}

const offset = 18926;
const start = Math.max(0, offset - 100);
const end = Math.min(targetLine.length, offset + 100);

console.log('Snippet around crash point:');
console.log(targetLine.substring(start, end));
