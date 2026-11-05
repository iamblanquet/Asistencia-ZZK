# Respaldo cifrado de usuarios y huellas (F22/F22ID)

## ASISTO: descarga local y recuperacion

Los administradores tienen el boton **Personal > Respaldos** en cada biometrico.

- **Descargar respaldo**: descarga directa, sin contrasena manual, de un `.zkbio`
  cifrado con todos los registros de usuarios y sus huellas. Cada archivo se
  descifra y verifica internamente antes de enviarse al navegador.
- **Descargar clave**: copia `.zkkey` de la clave de recuperacion de esta
  instalacion. Guardarla separada de los respaldos y fuera de Git. Es necesaria
  si se pierde el servidor o se reinstala ASISTO sin su directorio de datos.
- **Recuperar usuario**: archivo `.zkbio` y vista previa del reloj. La clave del
  servidor se utiliza automaticamente; no se solicita contrasena. Una clave
  externa puede seleccionarse en la seccion opcional de otra instalacion.
  Solo permite elegir usuarios ausentes, normales y con plantillas validas.
  Requiere escribir el ID exacto y confirmar el dispositivo antes de cargar.
- El respaldo debe corresponder al mismo ID de biometrico, serie, modelo y
  firmware. No se copian huellas entre dispositivos. Un UID ocupado, huellas
  residuales, usuarios existentes o privilegiados bloquean la recuperacion.
- Recupera todas las huellas validas del usuario elegido; verifica cada registro
  y plantilla despues de cargar y conserva intactos los demas datos actuales.
  No hace borrados, reinicios ni cambios de opciones del reloj.
- Actualiza el directorio SQL al verificar una recuperacion. El reconocimiento
  fisico sigue requiriendo una prueba de la persona en el lector.

Los archivos web nuevos (version 3) usan AES-256-GCM con clave aleatoria por
archivo y RSA-OAEP-SHA256 (3072 bits) para proteger esa clave. La identidad de la
clave se autentica junto al archivo. La clave privada de la instalacion se guarda
en `server/data/biometric-keys/recovery-key.pem`, modo 0600, directorio 0700 en
Linux. No se regenera ni reemplaza silenciosamente si esta corrupta. En Windows
se deben restringir ademas las ACL NTFS del directorio privado.

Las plantillas sin cifrar NO se guardan en SQL, archivos temporales, auditoria ni
almacenamiento del navegador. Solo se mantienen en RAM durante la operacion. El
navegador recibe el archivo cifrado y metadatos de vista previa, nunca plantillas
sin cifrar. Solo los administradores pueden descargar la clave privada; esta no
se muestra ni se incluye en logs o auditoria. Usar HTTPS en produccion. Una clave
externa seleccionada para recuperacion solo permanece en RAM, no se importa
automaticamente al almacen del servidor.

La auditoria `biometric_backup_actions` conserva operacion, actor, biometrico,
cantidades y resultado, sin contrasenas ni plantillas. La vista previa vence a
los 5 minutos, es de un solo uso y esta vinculada al administrador, dispositivo,
archivo y estado del reloj. Tras cambios se debe consultar de nuevo. Se limitan
los intentos de apertura y las operaciones simultaneas. Comparte la cola de
conexion con sincronizaciones y bloquea enrolamientos/ediciones concurrentes.

Las copias RSA anteriores (version 1) siguen siendo validas con su clave privada
local mediante CLI o seleccionando esa clave en la opcion de clave externa.
Las copias web anteriores (version 2, AES/scrypt) siguen cifradas con su
contrasena original: quitar el campo de la pantalla no elimina esa proteccion.
Descargar una copia nueva del reloj para usar el flujo sin contrasena. No se
modifican ni borran archivos antiguos. CLI y API conservan compatibilidad con la
contrasena original cuando esta disponible.

Para verificar un respaldo nuevo fuera de ASISTO, usar su clave de recuperacion:

```sh
node server/biometric-backup.js verify --input respaldo.zkbio --serial SERIE --private-key clave.zkkey
```

El cron de asistencias sigue respaldando usuarios/checadas en SQL. Los archivos
de huellas de esta pantalla se generan a peticion y se descargan localmente; no
se habilita una tarea automatica. El respaldo de SQLite no incluye por si solo
el archivo de clave: incluir el directorio privado completo o guardar `.zkkey`
por separado. Conservar tambien la identidad/configuracion SQL del dispositivo.

Pruebas web sin dispositivos reales:

```sh
node --test server/biometric-web.test.js server/cached-attendance.test.js
```

## Herramientas administrativas RSA y prueba controlada

Utilidad administrativa de linea de comandos. No agrega una descarga publica ni
envia plantillas al navegador. Solo lee el reloj: no inicia enrolamientos, no
escribe usuarios/huellas, no borra checadas y no cambia configuracion.

## Alcance

- Incluye registros completos de usuarios de 72 bytes (tambien pueden contener
  credenciales/tarjetas) y plantillas de huellas con UID, dedo y estado original.
- Asocia cada huella con su usuario y valida tamanos, duplicados y contadores.
- Compara hashes antes, durante y despues; rechaza capturas inconsistentes.
- Cifra el contenido con AES-256-GCM y una clave aleatoria por archivo; protege
  esa clave con RSA-OAEP-SHA256 (RSA minimo 3072 bits).
- La clave privada solo se necesita para verificar/descifrar y debe permanecer
  fuera del servidor de captura, del repositorio y de los respaldos compartidos.
- No incluye rostros, fotos, checadas ni configuracion del equipo. El respaldo SQL
  sigue siendo independiente y no contiene estas plantillas.
- Verificar el archivo NO demuestra restauracion en hardware. Esta utilidad NO
  tiene comando de restauracion y no garantiza compatibilidad entre firmwares.

## Uso

Ejecutar desde una copia autorizada del proyecto con las dependencias instaladas.
En Windows, restringir primero los permisos NTFS de la carpeta de claves al
propietario; los modos POSIX de Node no sustituyen las ACL de Windows.

```sh
node server/biometric-backup.js keygen --directory /ruta/privada/claves
```

Copiar unicamente `biometric-backup-key.public.pem` al servidor de captura.
Elegir un momento sin sincronizacion, enrolamiento ni administracion de usuarios
del mismo equipo. La herramienta independiente no comparte la cola del proceso
HTTP; la doble lectura detecta cambios, pero no impide operaciones concurrentes.
Confirmar IP y numero de serie por un canal conocido antes de la primera copia.

```sh
node server/biometric-backup.js export --ip IP_AUTORIZADA --serial SERIE_ESPERADA --device-id ID_DISPOSITIVO --name NOMBRE --public-key /ruta/clave.public.pem --output /ruta/privada/respaldo.zkbio
```

El archivo de salida no se sobrescribe, se crea con modo 0600 en Linux y solo
contiene el sobre cifrado. No se escribe ningun archivo temporal sin cifrar.
Transferirlo al equipo que guarda la clave privada y verificar alli:

```sh
node server/biometric-backup.js verify --input /ruta/respaldo.zkbio --private-key /ruta/privada/claves/biometric-backup-key.private.pem --serial SERIE_ESPERADA
```

La salida muestra cantidades e identidad del reloj, no nombres ni plantillas.
Conservar la clave privada por separado con acceso restringido: sin ella no se
puede recuperar el contenido. No compartir archivos por correo o Git. Definir
retencion y acceso de acuerdo con las politicas de datos biometricos aplicables.

## Pruebas sin reloj

```sh
node --test server/biometric-backup.test.js
```

Incluyen integridad, asociaciones usuario/dedo, cifrado, clave incorrecta,
manipulacion, capturas concurrentes, limpieza de buffers y no sobrescritura.

Los respaldos conservan todos los registros si un reloj entrega mas de una
plantilla para un mismo dedo. El contador de plantillas corresponde a registros,
no a posiciones distintas. La comparacion de integridad incluye cada registro y
su multiplicidad, aunque el reloj cambie el orden de entrega. La restauracion de
un usuario con posiciones repetidas queda bloqueada para revision: no se elige
ni se descarta una de sus plantillas automaticamente.

## Prueba controlada de carga identica

`server/biometric-restore-test.js` es una herramienta separada para una prueba
administrativa autorizada. Recibe el respaldo ya descifrado por stdin, solo en
RAM; usar un canal SSH, nunca argumentos ni un archivo JSON sin cifrar. La clave
privada permanece en el equipo local.

Por defecto solo compara y propone un usuario normal con una sola huella valida.
Requiere que IP, serie, modelo, firmware, todos los usuarios y todas las huellas
coincidan exactamente con el respaldo. Si hay altas, bajas o cambios, se detiene.
No recupera usuarios ausentes ni reemplaza huellas distintas.

La escritura exige `--execute --employee-id ID --finger-index DEDO`, ademas de
`--ip`, `--serial` y `--database` (SQLite de produccion, abierta en solo lectura
para verificar que no haya otras escrituras activas). `--report` conserva un
reporte privado sin plantillas, credenciales ni nombres. Ejecutarla en un momento
sin otras operaciones del reloj; no comparte la cola del proceso HTTP.

Usa el formato de carga de [pyzk HR_save_usertemplates](https://github.com/fananimi/pyzk/blob/master/zk/base.py),
conservando los 72 bytes originales del usuario, sin reconstruir campos por
defecto. Solo carga un usuario y su unica plantilla, sin comandos de borrado,
reinicio, bloqueo del equipo ni cambio de opciones. Relee despues todas las
plantillas y usuarios. Una respuesta ACK por si sola no se considera exito.

Una carga identica verificada demuestra aceptacion del protocolo y conserva el
estado; NO demuestra recuperacion tras borrado ni reconocimiento fisico del dedo.
No se realizan borrados automaticos para ampliar la prueba.

```sh
node --test server/biometric-backup.test.js server/biometric-restore-test.test.js
```

## Recuperacion puntual despues de eliminar un usuario

El modo `--mode recover-missing` de `server/biometric-restore-test.js` permite una
prueba autorizada de recuperacion de un usuario normal con UNA huella valida.
Este alcance es intencional: el preparador rechaza usuarios privilegiados o con
varias huellas, en lugar de recuperar solo parte de sus datos silenciosamente.

1. Crear un respaldo nuevo, transferirlo y descifrar/verificar su integridad.
2. Pasar el contenido por stdin/SSH al modo de recuperacion, con IP, serie, base
   de datos, `--employee-id` y `--expected-name` exactos. Sin `--execute`, solo
   comprueba: `waiting_for_deletion` si sigue presente o `ready_to_restore` si
   falta y todos los demas registros coinciden con el respaldo.
3. Solo despues de confirmar manualmente el borrado, repetir con `--execute
   --confirmed` y una ruta de reporte nueva. No hay ningun borrado automatico.
4. Verificar de nuevo tras desconectar/reconectar y pedir una prueba fisica de
   reconocimiento. Sincronizar despues ASISTO para actualizar el directorio SQL.

No cambia el ID ni el UID originales. Si otro usuario ocupa alguno, si quedan
huellas residuales o si cambiaron otros usuarios/huellas desde el respaldo,
rechaza la operacion antes de escribir. El usuario presente nunca se reemplaza.
Solo envia el registro original seleccionado y su huella; no restaura todo el
dispositivo, no borra checadas ni cambia la configuracion. Compara todos los
registros y plantillas despues de la carga, no solo los contadores o el ACK.

```sh
node --test server/biometric-user-recovery.test.js
```
