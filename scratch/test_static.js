const http = require('http');

function testUrl(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          contentType: res.headers['content-type'],
          contentSnippet: data.substring(0, 150)
        });
      });
    }).on('error', (err) => {
      resolve({ error: err.message });
    });
  });
}

async function run() {
  const root = await testUrl('http://127.0.0.1:5174/');
  const js = await testUrl('http://127.0.0.1:5174/assets/index-BNk1tEoc.js');
  console.log('Root Path Response:', root);
  console.log('JS Asset Response:', js);
}

run();
