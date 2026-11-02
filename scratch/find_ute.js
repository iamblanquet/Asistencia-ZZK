const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../dist/assets/index-BNk1tEoc.js');
const content = fs.readFileSync(filePath, 'utf8');

// The crash point is around index 1021473. Let's look backward for the start of the function, which should contain "function ute(" or similar.
const index = 1021473;
const start = Math.max(0, index - 8000);
const snippet = content.substring(start, index + 100);

// Print the beginning of the function
const funcStart = snippet.indexOf('function ');
if (funcStart !== -1) {
  console.log('Found function start:');
  console.log(snippet.substring(funcStart, funcStart + 2500));
} else {
  console.log('Function start not found in snippet. Printing first 1000 characters of snippet:');
  console.log(snippet.substring(0, 1000));
}
