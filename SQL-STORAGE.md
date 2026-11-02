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

## Migracion

En el primer arranque se respaldan los archivos JSON/DB antiguos en server/data/pre-sqlite-* y se importan dentro de una unica transaccion. Un error aborta la migracion. Las claves existentes se conservan; los nuevos usuarios usan scrypt. No se modifica el reloj.

Un nombre global antiguo solo se asigna automaticamente cuando se identifica un unico dispositivo. Si es ambiguo, se conserva en migration_issues para revision; no se replica a todos los relojes. Los eventos sin dispositivo conocido tambien se conservan alli y no se atribuyen por suposicion.

Despues de migrar, los archivos antiguos no se actualizan ni se reimportan. La tabla migrations evita repetir la importacion al reiniciar.

## Respaldos y recuperacion

Para copiar una base activa usar la API backup de better-sqlite3 o la utilidad sqlite3 .backup. Para una copia por archivos detener antes el servicio y respaldar toda server/data, incluidos archivos -wal y -shm si existen. Copiar solo asistencia.sqlite mientras esta en uso puede producir un respaldo incompleto.

Mantener un respaldo privado antes de actualizar. Para volver a una version previa restaurar tanto el codigo como los datos de ese respaldo: los JSON antiguos no incluyen cambios posteriores a la migracion.

Instalar dependencias con npm ci (o npm ci --omit=dev en el servidor). better-sqlite3 requiere su binario nativo: no usar --ignore-scripts al instalar esta version.

## Pruebas

Las horas extra se reconocen en bloques completos de 60 minutos posteriores a la salida programada, por empleado y jornada. Los minutos restantes se descartan antes de sumar el periodo: 20 minutos un dia y 40 al siguiente no generan horas extra; 80 minutos en una jornada generan 60 minutos reconocidos. La tolerancia sigue aplicando solamente a la entrada.

node --test server/sqlite-isolation.test.js server/source-attendance.test.js

Las pruebas usan datos temporales y no conectan al reloj. Comprueban migracion, IDs repetidos, permisos, nombres, horarios, deduplicacion, reapertura y conservacion de historial.
