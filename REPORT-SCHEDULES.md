# Horarios de reportes por grupos

En Personal > Horarios se crean grupos, por ejemplo Temprano u Oficina, y se seleccionan
varios colaboradores mediante casillas. La busqueda filtra por nombre o ID; Seleccionar
resultados afecta solo a los colaboradores visibles en esa busqueda.

Cada horario define entrada y salida L-V, entrada y salida del sabado, tolerancia de
entrada y fecha de vigencia. Cada colaborador tiene como maximo un grupo por fecha
y biometrico. Un mismo ID en otro equipo es independiente. Un colaborador sin grupo
usa el horario general de ese biometrico. Para devolverlo al general, desmarcarlo en
su grupo y guardar. Seleccionarlo en otro grupo lo mueve desde la fecha elegida.

## Domingo opcional

El interruptor Anadir domingo esta disponible tanto en Horario general como en
cada grupo. Al activarlo aparecen Entrada domingo y Salida domingo. La tolerancia
de entrada es la misma del grupo. Los horarios nuevos y los equipos nuevos tienen
domingo desactivado inicialmente; la opcion no cambia ninguna asignacion.

Con domingo desactivado no se exige una jornada dominical. Si existen checadas,
se conservan como Sin horario y se acumula el tiempo trabajado, pero no se generan
retardos, salidas tempranas, dias incompletos ni horas extras automaticas. Una sola
checada sigue visible, sin inventar su salida ni el tiempo trabajado. La tabla
permite filtrar Sin horario; PDF, CSV y graficas usan la misma regla.

Activarlo o desactivarlo se guarda con Vigencia desde. Las versiones antiguas que
no tenian esta opcion mantienen su calculo anterior: domingo con las horas L-V.
Al abrirlas el interruptor aparece activado con esas horas; no se reescriben datos
ni versiones historicas al instalar la funcion. Para dejar de programar domingo,
desactivarlo y guardar una nueva vigencia. Un turno nocturno del sabado conserva
su salida de madrugada aunque el domingo este desactivado; un turno nocturno del
domingo activado puede finalizar el lunes.

Los campos persistidos en el JSON de la vigencia son sundayEnabled,
sunShiftStart y sunShiftEnd. Se validan horas y estado; no se pueden cambiar por
el formulario de conexion del equipo. No se ejecutan comandos sobre los relojes.

El icono de reloj de la columna Acciones abre Asignar horario para ese colaborador.
Permite elegir un grupo existente o volver al general y elegir la fecha, sin
recorrer toda la lista. Conserva las asignaciones pasadas y futuras; exige que el
grupo ya tenga una vigencia en la fecha seleccionada.

Guardar una fecha nueva conserva las vigencias anteriores. Editar una fecha ya
existente corrige esa vigencia; se conserva la auditoria anterior en SQL. Las
asignaciones futuras ya programadas se conservan. El nombre del grupo es compartido
por todas sus vigencias. La lista Vigencias guardadas permite consultar/corregirlas.

## Horario general con historial

Personal > Horarios > Horario general permite cambiarlo con la misma fecha de
vigencia que los grupos. Al migrar se conserva una unica copia original por equipo
con los valores que existian, incluido el cero de tolerancia. Esa base original
no se puede sobrescribir desde la aplicacion. Las vigencias nuevas solo se usan
desde su fecha; modificar una vigencia ya creada corrige ese periodo y queda
auditado. No es posible reconstruir ajustes que se hubieran sobrescrito antes
de esta migracion, salvo con respaldos anteriores.

Los dias sin grupo utilizan la version general de su fecha, incluso si un
colaborador vuelve al general despues de pertenecer a un grupo. La configuracion
de conexion ya no permite editar horarios existentes sin vigencia; su acceso
Gestionar horarios abre la misma gestion de reportes. Crear un nuevo equipo sigue
permitiendo definir su horario inicial. Ninguna de estas operaciones escribe al
reloj; los ajustes generales anteriores tampoco se reemplazan en devices.config.

Los calculos diarios, indicadores, graficas, clasificacion del historial de eventos
y PDF utilizan el grupo vigente en la fecha de la jornada. El reporte individual
incluye nombre del horario, entrada/salida esperadas y tolerancia por dia. La
tolerancia se aplica solo al retardo de entrada; no compensa salidas tempranas ni
descuenta horas extra. Se conserva la regla de una hora extra desde 50 minutos
posteriores a la salida, calculada por colaborador y dia, sin sumar fracciones.

Las jornadas nocturnas agrupan las salidas de madrugada en el dia de inicio; el
punto medio del descanso entre salida anterior y siguiente entrada separa las
jornadas. Horarios superpuestos o checadas omitidas requieren revision humana.
La consulta incluye por separado las marcaciones de los dias contiguos para no
perder una salida nocturna al final del periodo. La bitacora mantiene sus fechas
calendario y el orden descendente.

## Persistencia y seguridad

- Solo SQLite: no cambia configuracion, usuarios, huellas ni eventos del biometrico.
- GET/POST `/api/device/report-schedules?deviceId=...`.
- PUT `/api/device/report-schedules/:id?deviceId=...`.
- PUT `/api/device/report-schedules/general?deviceId=...`.
- GET/PUT `/api/employees/:id/report-schedule?deviceId=...` para asignacion rapida.
- report_general_schedule_state y report_general_schedule_versions conservan la
  base y las vigencias generales por equipo, con control de revision.
- Operadores: solo dispositivos asignados, igual que los horarios generales.
- Escrituras transaccionales, control de revision para evitar sobrescribir otra
  sesion, fechas/horas validadas y auditoria de cambios.
- Las sincronizaciones y restauraciones del roster no borran las asignaciones.
- Los datos existentes permanecen con el horario general hasta asignarlos.

## Pruebas

`node --test server/report-schedules.test.js server/general-schedules.test.js server/sunday-schedules.test.js server/source-attendance.test.js server/report-schedules-pdf.test.js server/csv-export.test.js`

Las pruebas usan bases temporales y conexiones de reloj simuladas. No modifican
empleados ni horarios reales. La interfaz se reorganiza en una columna a 680 px
y permite desplazamiento interno para conservar el acceso a los botones en movil.
