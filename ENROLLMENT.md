# Registro de huellas

Personal > Registrar huella esta disponible para administradores y operadores.
El operador solo puede usar biometricos asignados a su cuenta. Puede registrar
una posicion libre de un colaborador normal existente o crear un colaborador
normal con ID automatico. La compatibilidad existente sigue limitada a F22/F22ID
por TCP; esta funcion no habilita enrolamiento en otros modelos.

El registro conserva la confirmacion del equipo, colaborador y dedo y el
consentimiento de la persona presente. No reemplaza huellas ocupadas, no modifica
roles ni permite elegir credenciales o privilegios al crear un colaborador.

Solo un administrador de ASISTO puede registrar huellas de usuarios que ya tengan
privilegios en el reloj. El servidor comprueba el rol real del colaborador antes
de iniciar captura, aunque se invoque directamente la API sin usar la pantalla.
La interfaz del operador no ofrece esos colaboradores como opciones.

Cada operador consulta, recupera y cancela sus propios trabajos, siempre dentro
de sus sedes asignadas. Los administradores pueden supervisar y cancelar los
trabajos de todos. Un trabajo de otra cuenta o sede devuelve 404. Las
asignaciones y permisos se vuelven a comprobar al ejecutar la captura y durante
la espera, para no seguir con permisos revocados o una cuenta eliminada.

El inicio queda auditado con el ID de la cuenta autenticada. Los datos enviados
por el cliente no pueden reemplazarlo ni otorgar privilegios administrativos.
Ni hashes ni bytes de plantillas se entregan al navegador. La finalizacion se
confirma leyendo la huella almacenada y comprobando que los otros registros y
huellas sigan intactos; un ACK no se presenta como registro completado.

Respaldos, restauracion, clave de recuperacion y administracion de cuentas del
portal siguen siendo exclusivos de administradores. Los operadores tambien
pueden editar nombres y eliminar colaboradores normales en sus biometricos
asignados; se conservan las protecciones y confirmaciones de
[DEVICE-USERS.md](DEVICE-USERS.md). No se cambia la configuracion de los
biometricos ni se realiza ninguna captura automaticamente al instalar esta
actualizacion.

El dedo se elige en dos manos visuales (izquierda y derecha), tambien navegables
con Tab y las flechas del teclado. Naranja identifica la seleccion y verde con
una marca identifica una huella registrada, que no se puede seleccionar de nuevo.
La seleccion conserva los indices del protocolo ZK (0 a 9) y cambia unicamente la
interfaz, no los permisos ni la configuracion del reloj. Al cambiar de dedo se
debe confirmar de nuevo el colaborador, dedo y biometrico.

La lectura admite varias plantillas para la misma posicion del dedo, como las
detectadas en Base Peru. Se comprueba el contador de registros del reloj, no solo
el numero de dedos distintos. Cada posicion conserva una firma de todos sus
registros (incluidas repeticiones), sin depender de su orden. Ningun registro se
descarta ni se borra para permitir otro enrolamiento. Las posiciones ocupadas
siguen bloqueadas y un cambio en cualquier plantilla anterior impide confirmar
el nuevo registro como correcto.

Pruebas: `node --test server/enrollment.test.js server/enrollment-access.test.js server/fingerprint-records.test.js server/cached-attendance.test.js`.
