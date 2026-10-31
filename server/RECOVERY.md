# API recuperada

Arranque desde la carpeta del proyecto: `npm start`.
Instalacion de dependencias del servidor: `npm install --prefix server`.
Direccion local: http://127.0.0.1:5175/.

Esta implementacion reconstruye las rutas de lectura que utiliza la interfaz compilada. No es una recuperacion del codigo original perdido.

Rutas disponibles: acceso y cierre de sesion, consulta del usuario actual, listado y gestion local de dispositivos, lectura de eventos y empleados, diagnostico y nombres locales de empleados.

Los datos locales se guardan en `server/data`. Conservar esta carpeta para mantener el acceso y los registros recuperados. Las contrasenas se almacenan mediante scrypt. Las sesiones caducan a las ocho horas y se invalidan al reiniciar.

La lectura ZK consulta usuarios, asistencias e informacion del dispositivo. No ejecuta cambios de horario, borrado de registros, reinicio, bloqueo ni escritura de usuarios en el reloj. El comando de liberacion de buffer utilizado por la biblioteca solo libera el buffer de transferencia.

La administracion de usuarios adicionales aun no esta reconstruida. El usuario administrador existente se conserva.

Una conexion exitosa no garantiza que el firmware EWL20 exponga su historial por protocolo ZK. Los errores y registros vacios no deben interpretarse como una descarga exitosa si el equipo reporta registros pendientes.
