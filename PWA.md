# Instalacion de ASISTO

Produccion: https://asisto.itzamna.mx. Requiere HTTPS (localhost tambien permite
desarrollo). Abrir la pagina actualizada y elegir Instalar cuando el navegador
ofrezca la opcion; tambien puede aparecer en la barra de direcciones o en su menu.
En Safari para iPhone/iPad se utiliza Compartir > Agregar a pantalla de inicio.
La disponibilidad exacta del aviso depende del navegador y de si ya esta instalada.

## Comportamiento

- Manifest con identidad estable, modo standalone e iconos 192, 512, maskable y Apple.
- El service worker de Workbox solo precarga archivos estaticos del build.
- API, empleados, asistencias, PDF y respaldos no se guardan en Cache Storage.
- Sin red puede abrirse la interfaz; consultar datos, autenticarse o administrar
  biometricos sigue requiriendo conexion al servidor.
- Una nueva version muestra Actualizar; no se fuerza la recarga automatica de
  formularios abiertos. El aviso queda debajo de los dialogos de edicion.
- Cerrar sesion mantiene el comportamiento de autenticacion existente.
- No se agregan notificaciones push, sincronizacion offline ni permisos adicionales.

## Compilacion y despliegue

`npm ci` y `npm run build`. El servidor debe publicar todo `dist`, incluidos
`manifest.webmanifest`, `sw.js`, `workbox-*.js` y los iconos. Publicar primero los
assets, despues el HTML y por ultimo el service worker evita mezclar versiones.
Los assets con hash anteriores deben conservarse mientras existan pestanas abiertas.
El servidor actual ya envia Cache-Control: no-store para evitar un sw.js obsoleto.

Pruebas: `node --test server/pwa.test.js`, despues de compilar.
La instalacion final la confirma el usuario en el navegador; no se instala software
automaticamente durante el despliegue.

## Dependencias

Vite PWA y Workbox se utilizan para generar y registrar el worker. La auditoria npm
del proyecto tambien reporta avisos en dependencias anteriores y transitivas. Este
cambio no aplica actualizaciones mayores automaticas de librerias no relacionadas.
