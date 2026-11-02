const { exec } = require('child_process');
const http = require('http');

// 1. Launch Chrome with remote debugging
const chromePath = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
const chromeCmd = `${chromePath} --headless --remote-debugging-port=9222 --disable-gpu --user-data-dir="${__dirname}/chrome-profile"`;

console.log('Launching headless Chrome...');
const chromeProcess = exec(chromeCmd);

// Wait for Chrome to start up
setTimeout(async () => {
  try {
    // 2. Fetch target WebSocket debugger URL
    http.get('http://127.0.0.1:9222/json/list', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const pageTarget = targets.find(t => t.type === 'page');
          if (!pageTarget) {
            console.error('No page target found in Chrome.');
            cleanup();
            return;
          }
          
          const wsUrl = pageTarget.webSocketDebuggerUrl;
          console.log('Connecting to DevTools WebSocket:', wsUrl);
          
          const ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            console.log('WebSocket connection established. Initializing domains...');
            ws.send(JSON.stringify({ id: 1, method: 'Console.enable' }));
            ws.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
            ws.send(JSON.stringify({ id: 3, method: 'Page.navigate', params: { url: 'http://localhost:5174/' } }));
          };
          
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            
            // Log console messages
            if (msg.method === 'Runtime.consoleAPICalled') {
              const args = msg.params.args.map(a => a.value || JSON.stringify(a)).join(' ');
              console.log(`[Browser Console - ${msg.params.type}]:`, args);
            }
            
            // Log exceptions
            if (msg.method === 'Runtime.exceptionThrown') {
              console.error('\n--- BROWSER EXCEPTION DETECTED ---');
              console.error(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
              console.error('---------------------------------\n');
            }
          };
          
          ws.onerror = (err) => {
            console.error('WebSocket Error:', err);
          };
          
        } catch (e) {
          console.error('Error parsing targets:', e);
          cleanup();
        }
      });
    }).on('error', (err) => {
      console.error('Error contacting Chrome debugging port:', err.message);
      cleanup();
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    cleanup();
  }
}, 2000);

// Cleanup function to close Chrome and exit
function cleanup() {
  console.log('Cleaning up browser process...');
  chromeProcess.kill();
  process.exit(0);
}

// Keep running for 8 seconds to allow the bundle to load and execute
setTimeout(cleanup, 8000);
