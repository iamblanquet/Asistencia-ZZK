# Asistencia ZKTeco

Proyecto React + Node para leer usuarios y eventos de asistencia de lectores ZKTeco compatibles con el protocolo local ZK, incluyendo WL20/EWL20 cuando el equipo permite conexion PC por Wi-Fi/red.

## Requisitos

- Node.js 20 o superior.
- Acceso de red desde la computadora del backend hacia el biometrico.
- Equipo ZKTeco conectado a la misma red o VPN.
- Puerto ZK local habilitado, normalmente `4370`.
- En el equipo, validar que la conexion PC/red este activa. Si el equipo solo esta en modo USB, app movil o ADMS, este flujo no aplica hasta implementar ese adaptador.

## Configuracion

Los dispositivos se administran desde la app y se guardan en `server/data/devices.db`. Cada dispositivo puede definir:

```json
{
  "name": "Entrada Principal",
  "model": "WL20/EWL20",
  "protocol": "zk",
  "ip": "192.168.1.201",
  "port": 4370,
  "timeout": 15000,
  "inport": 4000
}
```

Tambien puedes copiar `.env.example` a `.env` para definir un dispositivo base si la base local no existe:

```env
ZKTECO_NAME=Entrada Principal
ZKTECO_MODEL=WL20/EWL20
ZKTECO_PROTOCOL=zk
ZKTECO_IP=192.168.1.201
ZKTECO_PORT=4370
ZKTECO_TIMEOUT=15000
ZKTECO_INPORT=4000
API_PORT=5174
```

## Uso

```bash
npm install
npm run dev
```

Frontend:

```text
http://127.0.0.1:5173
```

API:

```text
http://127.0.0.1:5174
```

## Diagnostico del EWL20/WL20

1. Conecta el equipo al Wi-Fi.
2. Revisa la IP asignada en el menu de red del lector.
3. Agrega el dispositivo en la app con modelo `WL20/EWL20`, protocolo `ZK local TCP/UDP`, puerto `4370`, timeout `15000` e inport `4000`.
4. Usa el boton de prueba de conexion en el centro de dispositivos.
5. Para WL20/EWL20 la app inicia captura en vivo automaticamente al seleccionar el equipo. Esto no cambia configuracion del dispositivo; solo mantiene una conexion de lectura para guardar nuevas marcaciones.

Endpoints utiles:

```text
GET /api/device/diagnostics?deviceId=dev-id
GET /api/device/realtime/status?deviceId=dev-id
POST /api/device/realtime/start?deviceId=dev-id
POST /api/device/realtime/stop?deviceId=dev-id
GET /api/device/status?deviceId=dev-id
GET /api/events?deviceId=dev-id
POST /api/events/import?deviceId=dev-id
```

Si el equipo responde usuarios pero `events: 0`, el historico no esta siendo expuesto por el comando ZK local. En ese caso hay dos rutas sin modificar configuracion del dispositivo:

- Captura en vivo: guarda marcaciones nuevas mientras el servidor este encendido.
- Importar ATTLOG: carga un TXT/CSV exportado del equipo o USB para recuperar historico.

## Reporte PDF

La app genera reportes por rango de fecha con:

- Eventos de asistencia.
- Primera y ultima marcacion del dia.
- Horario laboral por dispositivo.
- Tolerancia de retardo.
- Horas trabajadas, retardos, salidas tempranas y horas extra.

Si hay una sola marcacion en un dia, el registro aparece como `Incompleto`.
