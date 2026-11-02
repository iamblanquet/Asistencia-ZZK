# Asistencia ZKTeco con SQLite

Esta version incluye el codigo fuente React, la interfaz compilada y la API Node. Usuarios, dispositivos, empleados, permisos y marcaciones se guardan en SQLite, con separacion por biometrico.

## Arranque (Node.js 20+)

```powershell
npm ci
npm run build
$env:INITIAL_ADMIN_PASSWORD = 'REEMPLAZAR-POR-UNA-CLAVE-UNICA'
npm start
```

La clave inicial debe tener al menos 12 caracteres. Solo se utiliza si no hay usuarios ni archivos anteriores para migrar. El usuario inicial es admin. No hay una clave de acceso incluida en el repositorio.

Para produccion con dist ya compilado, instalar con npm ci --omit=dev. No usar --ignore-scripts: better-sqlite3 necesita instalar su binario nativo.

La API usa API_PORT (5174 por defecto) y HOST (127.0.0.1 por defecto). En el servidor, deploy/asistencia-zzk.service configura el puerto 5175 y la zona horaria America/Mexico_City. El proxy HTTPS sirve https://asisto.itzamna.mx.

## Datos

El archivo principal es server/data/asistencia.sqlite. Esta carpeta es privada y esta excluida de Git. La primera ejecucion migra los JSON antiguos automaticamente, con respaldo y transaccion. No borrar la base para actualizar.

Consultar [SQL-STORAGE.md](SQL-STORAGE.md) para relaciones entre tablas, migracion, respaldos, casos ambiguos y recuperacion.

## Verificacion

```powershell
node --test server/sqlite-isolation.test.js server/source-attendance.test.js
```

Los scripts de reparacion de bundles compilados corresponden a la copia recuperada anterior. Para cambios nuevos editar src y ejecutar npm run build.
