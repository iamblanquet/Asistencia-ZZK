# Almacenamiento SQL por biometrico

Motor: SQLite mediante better-sqlite3. Archivo: server/data/asistencia.sqlite.
Utiliza claves foraneas, transacciones, WAL y un tiempo de espera para escrituras concurrentes.

## Separacion de datos

- devices: identidad y configuracion local de cada reloj. El borrado es logico; conserva historial.
- employees: clave primaria compuesta (device_id, employee_id). Los nombres editados son locales a ese reloj.
- events: clave primaria (device_id, employee_id, timestamp), con relacion al empleado del mismo reloj. Una descarga repetida no duplica la marcacion aunque cambie su origen.
- users y user_devices: usuarios del portal y asignaciones a dispositivos con claves foraneas.
- migrations y migration_issues: version y casos ambiguos de la migracion.

Los ajustes particulares del dispositivo y las credenciales protegidas se guardan como campos JSON dentro de tablas SQL; empleados, eventos y asignaciones usan columnas y relaciones SQL.

Las consultas de asistencia, importaciones, edicion de nombres y PDF deben indicar deviceId. Los operadores solo acceden a los dispositivos asignados. Un empleado con el mismo numero en dos dispositivos es tratado como dos registros independientes.

## Consulta y sincronizacion

### Sincronizacion nocturna

En produccion el servicio programa `59 23 * * *` en `America/Mexico_City` (23:59).
Descarga todos los biometricos activos secuencialmente, incluidos los que se agreguen despues.
Comparte la cola con las sincronizaciones manuales. Cada equipo tiene hasta tres intentos,
con 30 segundos de espera entre intentos; un fallo no borra historial ni detiene los demas.
La ejecucion puede terminar despues de medianoche si la descarga tarda.

`nightly_sync_runs` conserva fecha de corte, inicio, fin, estado y resultados por dispositivo.
Los detalles tambien aparecen en `journalctl --user -u asistencia-zzk` con prefijo `[nightly-sync]`.
Al arrancar comprueba el ultimo corte vencido y recupera una ejecucion pendiente, interrumpida
o fallida. No repite un corte completado. Una descarga completa recupera tambien jornadas
anteriores que sigan en memoria del reloj. Si un equipo sigue inaccesible no se pueden garantizar
sus datos; el fallo queda registrado. No reemplaza un respaldo externo de SQLite.

Se activa automaticamente con `NODE_ENV=production`; `ASISTENCIA_DAILY_SYNC=0` lo desactiva
y `ASISTENCIA_DAILY_SYNC=1` permite activarlo en otro entorno. No modifica ni borra datos del reloj.

GET /api/events y GET /api/employees leen exclusivamente SQLite. El filtro de periodo y empleado se aplica en SQL por deviceId; las consultas y los PDF no abren conexion al reloj. El historial permanece consultable aunque el equipo este desconectado.

POST /api/device/sync?deviceId=... es la operacion explicita para descargar empleados y marcaciones. Requiere acceso al dispositivo y mantiene una sola descarga en curso por reloj. Los datos se guardan en una transaccion y luego se vuelve a consultar SQLite. Un fallo no borra el historial ni cambia la fecha de ultimo exito.

La descarga TCP solicita bloques secuenciales y reconstruye tramas aunque la red las fragmente o agrupe. Valida los bytes declarados, los limites de registros y el contador de checadas antes de guardar. Una descarga parcial o un tiempo de espera no se registra como exito. No modifica la configuracion ni borra registros del biometrico.

device_sync_status conserva el ultimo intento, ultimo exito, ultimo error y la informacion obtenida en la descarga. fetchedAt ahora indica la ultima sincronizacion exitosa, no el momento de cada consulta. Para datos anteriores sin fecha fiable se devuelve null hasta la siguiente sincronizacion exitosa.

## Registro remoto de huellas

En Personal, los administradores pueden abrir Registrar huella. Primero se comprueba el ID
y las posiciones ocupadas directamente en el reloj. Se debe confirmar el consentimiento,
el empleado, el dedo y el biometrico antes de enviar la orden. Se admite crear un empleado
nuevo (ID numerico positivo sin ceros iniciales, hasta nueve digitos; nombre de hasta 24 bytes UTF-8),
siempre como usuario normal. Nunca se actualiza un ID existente ni se reemplaza una huella.

La operacion solo esta habilitada para equipos que reporten F22/F22ID por TCP. Es una
operacion de escritura intencional y separada de la sincronizacion de lectura. Utiliza la
misma cola de conexiones que las consultas al reloj y rechaza conexiones en tiempo real
simultaneas. No cambia horarios, red, contrasenas, privilegios, ni configuracion del biometrico.

El estado se consulta en SQL cada segundo. El backend espera hasta 90 segundos por la captura
y comprueba el contador de huellas cada dos segundos. No anuncia lecturas 1/3, 2/3, etc.
Solo confirma exito si encuentra la nueva posicion, comprueba que los usuarios y huellas
anteriores no cambiaron y el reloj acepto cancelar la captura y volver al modo normal.
Una cancelacion concurrente con una captura ya guardada informa el registro efectivo.
Si el equipo queda inaccesible o no se puede confirmar el resultado, se solicita revision,
sin afirmar que la huella se perdio. Crear un empleado no se revierte si la captura falla.

`enrollment_jobs` guarda auditoria por administrador, dispositivo, empleado y dedo, con
estado, fechas, cancelacion y resultado. No guarda imagenes, plantillas ni hashes biometricos.
Las plantillas se leen solo a memoria del servidor para verificar posiciones e integridad;
los buffers se limpian y nunca se envian al navegador. Las rutas `/api/device/fingerprints`
y `/api/device/enrollments` requieren administrador y `deviceId` explicito.
Los estados activos se recuperan al reabrir el dialogo. Un reinicio abrupto los marca para
revision; el apagado normal intenta cancelar la captura y restaurar el reloj antes de salir.

## Migracion de archivos anteriores

En el primer arranque se respaldan los archivos JSON/DB antiguos en server/data/pre-sqlite-* y se importan dentro de una unica transaccion. Un error aborta la migracion. Las claves existentes se conservan; los nuevos usuarios usan scrypt. No se modifica el reloj.

Un nombre global antiguo solo se asigna automaticamente cuando se identifica un unico dispositivo. Si es ambiguo, se conserva en migration_issues para revision; no se replica a todos los relojes. Los eventos sin dispositivo conocido tambien se conservan alli y no se atribuyen por suposicion.

Despues de migrar, los archivos antiguos no se actualizan ni se reimportan. La tabla migrations evita repetir la importacion al reiniciar.

## Respaldos y recuperacion

Para copiar una base activa usar la API backup de better-sqlite3 o la utilidad sqlite3 .backup. Para una copia por archivos detener antes el servicio y respaldar toda server/data, incluidos archivos -wal y -shm si existen. Copiar solo asistencia.sqlite mientras esta en uso puede producir un respaldo incompleto.

Mantener un respaldo privado antes de actualizar. Para volver a una version previa restaurar tanto el codigo como los datos de ese respaldo: los JSON antiguos no incluyen cambios posteriores a la migracion.

Instalar dependencias con npm ci (o npm ci --omit=dev en el servidor). better-sqlite3 requiere su binario nativo: no usar --ignore-scripts al instalar esta version.

## Pruebas

Las checadas de un empleado en la misma jornada se agrupan en intentos de hasta cinco minutos desde la primera marca del grupo (limite inclusivo, sin encadenar ventanas). Un solo intento deja la jornada incompleta, sin salida, horas trabajadas, salida temprana ni horas extra. Con dos o mas intentos se conserva la primera entrada y la ultima salida real. Las marcaciones originales permanecen en SQL y en la bitacora; esta agrupacion solo afecta los calculos y reportes, no la tolerancia de entrada.

Las horas extra se calculan por empleado y jornada desde la salida programada. Cada hora se reconoce al alcanzar 50 minutos: 49 minutos generan cero, 50 generan una hora, 109 generan una y 110 generan dos. Los sobrantes no se trasladan a otros dias ni empleados: 20 minutos un dia y 40 al siguiente no generan horas extra. La tolerancia sigue aplicando solamente a la entrada. Este resultado es calculado; las marcaciones originales no se alteran.

node --test server/sqlite-isolation.test.js server/source-attendance.test.js server/cached-attendance.test.js server/zk-tcp-download.test.js server/device-selection.test.js server/nightly-sync.test.js server/enrollment.test.js

Las pruebas usan datos temporales y no conectan al reloj. Comprueban migracion, IDs repetidos, permisos, nombres, horarios, deduplicacion, reapertura y conservacion de historial.
