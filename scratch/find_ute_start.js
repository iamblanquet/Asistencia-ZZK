const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../dist/assets/index-BNk1tEoc.js');
const content = fs.readFileSync(filePath, 'utf8');

const matchIndex = content.indexOf('function ute(');
if (matchIndex === -1) {
  console.log('function ute( not found. Let us search for "ute=" or similar.');
  const match2 = content.indexOf('ute=');
  if (match2 !== -1) {
    console.log('Found ute= at index:', match2);
    console.log(content.substring(match2, match2 + 2000));
  } else {
    console.log('Not found.');
  }
} else {
  console.log('Found function ute( at index:', matchIndex);
  console.log(content.substring(matchIndex, matchIndex + 2000));
}
