# Reparacion de identidades de checadas

Las checadas con ID explicito conservan ese ID. El UID del registro se almacena
por separado y nunca puede reemplazar el ID de otro colaborador. Un registro que
solo contenga UID requiere una correspondencia unica en el padron actual.

La herramienta solo admite bases dentro de `server/data` de esta copia del proyecto.
La lectura de usuarios y checadas no escribe en el biometrico. No ejecuta operaciones
de enrolamiento, borrado, cambio de nombre, cambio de hora ni permisos.

## Produccion: conservar el historial completo

Vista previa y aplicacion para un solo biometrico, utilizando su ID de ASISTO:

```sh
node server/repair-attendance-identities.js --device-id ID_DEL_BIOMETRICO
node server/repair-attendance-identities.js --device-id ID_DEL_BIOMETRICO --apply
```

Este modo conserva las checadas historicas y las fuentes distintas a `device`.
Requiere comprobar las checadas guardadas contra una lectura completa del mismo
reloj; si alguna no se puede verificar, se detiene sin modificar los registros.
Cada biometrico se procesa por separado, con su propio respaldo y auditoria.

No copie la base local ni su `.env` a produccion. No active `currentUsersOnly`
ni use `--rebuild` para aplicar solamente la correccion de ID/UID.

## Local: reconstruir con el padron actual

Vista previa, sin modificar las checadas:

```sh
node server/repair-attendance-identities.js --device-id dev-default --rebuild --expected-users 39
```

Reconstruccion exclusivamente desde las checadas del reloj para el padron actual:

```sh
node server/repair-attendance-identities.js --device-id dev-default --rebuild --expected-users 39 --apply
```

El numero esperado debe coincidir con el padron que entregue el reloj. La opcion
`--rebuild` requiere que el dispositivo tenga `currentUsersOnly: true` en la base
local. Excluye de la base activa las checadas de IDs dados de baja y otras fuentes.
Conserva un respaldo SQLite completo y verificado antes de cambiar datos.

La aplicacion se hace en una transaccion y comprueba que la base no haya cambiado
durante el respaldo. Valida cada ID, UID y fecha contra la descarga original,
registra el resultado en `attendance_identity_repairs` y revierte todos los cambios
si falla alguna comprobacion. No modifica otros dispositivos.

Sin `--rebuild`, se reparan solamente registros de origen `device` comprobables en
el reloj y se conservan las demas fuentes. Nunca se aplica ningun cambio sin `--apply`.

## Pruebas de regresion

```sh
node --test server/attendance-identity.test.js server/attendance-identity-repair.test.js server/cached-attendance.test.js server/sqlite-isolation.test.js
```

Cubren colisiones entre ID y UID, IDs historicos sin usuario actual, descargas
incompletas, sincronizaciones repetidas, respaldos, aislamiento por biometrico y
reversion atomica si falla una comprobacion.

## Nombres actuales del reloj

La opcion `namesFromDevice: true` en la configuracion de un biometrico dentro de
ASISTO toma los nombres de su padron verificado y elimina los alias locales de
los colaboradores presentes. No cambia la configuracion del reloj ni las checadas.
Los demas biometricos mantienen su politica de nombres y los alias historicos no
se eliminan si el colaborador ya no esta presente.

La lectura de nombres exige IDs explicitos, un padron completo y nombres con
codificacion valida. Conserva separados ID y UID y admite nombres UTF-8. Cuando
esta opcion esta activa, no se permiten nuevos alias locales que oculten el
nombre recibido del reloj. La opcion queda en la base de produccion, no en `.env`.

```sh
node --test server/device-names.test.js
```
