# Version recuperada

Esta copia contiene la interfaz compilada en dist y la API reconstruida en server. El codigo fuente original de la interfaz (src) falta; npm run build no esta disponible hasta recuperarlo. La administracion de usuarios adicionales aun no esta reconstruida.

## Arranque local (PowerShell, Node.js 20+)

```powershell
npm ci --prefix server --ignore-scripts
$env:INITIAL_ADMIN_PASSWORD = 'REEMPLAZAR-POR-UNA-CLAVE-UNICA'
npm start
```

Abrir http://127.0.0.1:5175/. Usuario inicial: admin. La clave debe tener al menos 12 caracteres y solo se usa para crear el acceso en el primer arranque. No hay una contrasena incluida en el repositorio.

server/data contiene credenciales con hash y datos privados del equipo. Esta excluido de Git: conservarlo en respaldos privados. Las sesiones duran ocho horas y se invalidan al reiniciar.

Configurar la IP y horarios desde el portal. La API lee usuarios y registros sin cambiar la configuracion del reloj. La descarga depende de la red y de lo que exponga el firmware ZK.

La tolerancia solo aplica a la entrada. Las horas extra cuentan desde la salida programada. Una unica marcacion queda como jornada incompleta.

## Pruebas

```powershell
node --test server/attendance-calculation.test.js
```

Dockerfile y docker-compose.yml pertenecen al proyecto anterior y requieren recuperar src antes de poder usarse. Usar el arranque local descrito arriba para esta copia.
