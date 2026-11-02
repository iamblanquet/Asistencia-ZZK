const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../dist/assets/index-BNk1tEoc.js');
const content = fs.readFileSync(filePath, 'utf8');

// Find all matches of ge as a variable/parameter or assignment in the file
const regex = /\b(let|const|var|function)\s+ge\b|ge\s*=\s*/g;
let match;
console.log('Matches for ge declarations:');
while ((match = regex.exec(content)) !== null) {
  const index = match.index;
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + 60);
  console.log(`Index ${index}:`, content.substring(start, end).replace(/\n/g, ' '));
}
