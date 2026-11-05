# Gestion de colaboradores del biometrico

En Personal, administradores y operadores pueden editar el nombre o eliminar un
colaborador normal del reloj. Los operadores solo pueden hacerlo en biometricos
asignados a su cuenta. Los botones de edicion y eliminacion estan en Acciones;
la edicion de este directorio actualiza el reloj, no solo un alias de ASISTO.

El servidor consulta los permisos actuales antes de entregar una confirmacion,
al ejecutar una operacion pendiente y justo antes de escribir en el reloj.
Una cuenta eliminada, sin asignacion o sin privilegios suficientes no puede
usar una confirmacion antigua. Cada token caduca en cinco minutos, es de un solo
uso y queda vinculado a la cuenta, el biometrico y el colaborador.

Los operadores no pueden editar usuarios con privilegios en el reloj, incluidos
roles personalizados o desconocidos. Los administradores de ASISTO conservan la
edicion del nombre de esos usuarios, pero nadie puede eliminarlos con esta
funcion. No se permite cambiar roles, IDs, contrasenas ni tarjetas mediante la
edicion de nombre.

Eliminar requiere consultar primero al colaborador, escribir su ID exacto y
confirmar explicitamente la eliminacion de su usuario y sus huellas. El historial
de asistencias y el ID historico permanecen en SQL. La recuperacion de una huella
requiere un respaldo valido previo; no hay una papelera automatica en el reloj.

Despues de una escritura se vuelve a leer el reloj y se comprueba el resultado
y que los otros usuarios y huellas sigan intactos. Una orden enviada sin poder
verificar se informa como pendiente de revision, no como exito. Cada accion se
audita con la cuenta autenticada, sin aceptar una identidad enviada en el cuerpo
de la peticion. Respaldos, restauracion, clave de recuperacion y administracion
de cuentas del portal siguen restringidos a administradores.

Pruebas sin dispositivos reales:

```sh
node --test server/device-users.test.js server/device-users-access.test.js
```
