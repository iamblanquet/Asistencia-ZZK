const http = require('http');

function makeRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const options = {
      hostname: '127.0.0.1',
      port: 5174,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    
    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, rawBody: data });
        }
      });
    });
    
    req.on('error', (e) => {
      reject(e);
    });
    
    if (body) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- INICIANDO PRUEBAS DE EDICIÓN DE DISPOSITIVOS POR OPERADORES ---');
  
  try {
    // 1. Login as admin
    console.log('1. Iniciando sesión como admin...');
    const adminLogin = await makeRequest('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    const adminToken = adminLogin.body.token;

    // 2. Get active devices
    console.log('2. Obteniendo lista de dispositivos...');
    const devicesList = await makeRequest('GET', '/api/devices', null, adminToken);
    const targetDevice = devicesList.body[0];
    if (!targetDevice) throw new Error('No se encontraron dispositivos en la base de datos.');
    console.log(`Dispositivo de prueba: ID=${targetDevice.id}, Nombre original="${targetDevice.name}", IP=${targetDevice.ip}`);

    // Save original parameters to restore later
    const originalGrace = targetDevice.graceMinutes || 10;
    const originalName = targetDevice.name;

    // 3. Create operator user
    console.log('\n3. Creando usuario operador de pruebas con acceso a este dispositivo...');
    const opUserPayload = {
      username: 'op_tester',
      password: 'oppassword',
      role: 'user',
      assignedDevices: [targetDevice.id]
    };
    const createOpRes = await makeRequest('POST', '/api/admin/users', opUserPayload, adminToken);
    const opUserId = createOpRes.body.user.id;

    // 4. Login as operator
    console.log('4. Iniciando sesión como el operador op_tester...');
    const opLogin = await makeRequest('POST', '/api/auth/login', { username: 'op_tester', password: 'oppassword' });
    const opToken = opLogin.body.token;

    // 5. Operator attempts to edit device config
    console.log('\n5. Operador intenta editar el dispositivo (modificando tolerancia a 45 y tratando de cambiar el nombre a "HACKED")...');
    const updatePayload = {
      ...targetDevice,
      name: 'HACKED NAME',
      ip: '10.10.10.10',
      graceMinutes: 45
    };
    
    const updateRes = await makeRequest('PUT', `/api/devices/${targetDevice.id}`, updatePayload, opToken);
    console.log(`Status de actualización: ${updateRes.statusCode} (Esperado: 200)`);
    console.log(`Nombre devuelto en respuesta: "${updateRes.body.name}" (Esperado: "${originalName}")`);
    console.log(`IP devuelta en respuesta: "${updateRes.body.ip}" (Esperado: "${targetDevice.ip}")`);
    console.log(`Tolerancia devuelta en respuesta: ${updateRes.body.graceMinutes} (Esperado: 45)`);

    if (updateRes.body.name === 'HACKED NAME' || updateRes.body.ip === '10.10.10.10') {
      throw new Error('¡FALLÓ DE SEGURIDAD! El operador pudo modificar campos restringidos (Nombre o IP).');
    }
    if (updateRes.body.graceMinutes !== 45) {
      throw new Error('¡FALLÓ! El operador no pudo modificar los minutos de tolerancia.');
    }
    console.log('¡ÉXITO! Los cambios en horarios/tolerancia se aplicaron pero los datos de conexión IP/Nombre quedaron bloqueados de forma segura.');

    // 6. Cleanup: restore original device configuration using admin token
    console.log('\n6. Restaurando valores originales del dispositivo...');
    const restorePayload = {
      ...targetDevice,
      name: originalName,
      graceMinutes: originalGrace
    };
    await makeRequest('PUT', `/api/devices/${targetDevice.id}`, restorePayload, adminToken);

    // 7. Cleanup: delete operator user
    console.log('7. Eliminando usuario operador de pruebas...');
    await makeRequest('DELETE', `/api/admin/users/${opUserId}`, null, adminToken);

    console.log('\n--- TODAS LAS PRUEBAS DE EDICIÓN RESTRINGIDA PASARON CON ÉXITO ---');
  } catch (e) {
    console.error('\n❌ ERROR EN LAS PRUEBAS:', e.message);
  }
}

// Wait for server to load and run tests
setTimeout(runTests, 1000);
