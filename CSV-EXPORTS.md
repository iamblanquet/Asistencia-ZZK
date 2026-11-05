# Exportaciones

Asistencia y la consulta de quincena permiten elegir PDF o CSV. El reporte completo
incluye cada dia, colaborador, horario historico y tolerancia, marcaciones, minutos
trabajados, retardos, salidas tempranas, horas extras e intentos repetidos.

Con todos los colaboradores seleccionados, CSV por Colaborador descarga un ZIP
con un CSV por persona y un resumen general. Con una sola persona seleccionada,
descarga directamente su CSV. CSV Resumen exporta los totales del periodo.

Bitacora ofrece CSV Eventos y CSV Totales. El directorio permite descargar PDF o
CSV de colaboradores. La columna de tarjeta ya no se muestra en Personal, pero
los datos almacenados se conservan y siguen disponibles en la exportacion.

Las exportaciones CSV leen el historial SQL del biometrico elegido, no consultan
ni modifican el dispositivo. Los reportes de asistencia respetan periodo,
colaborador, busqueda, estado y orden seleccionados. Bitacora respeta su periodo
y busqueda. Los horarios se resuelven por su vigencia en cada fecha.

Los CSV usan UTF-8 con BOM, comas, campos entre comillas y finales CRLF. Se
neutralizan formulas provenientes de valores de texto antes de abrirlos en una
hoja de calculo. Las fechas ISO UTC acompanian las horas locales en los detalles.

Las tablas aprovechan el ancho y la altura disponibles en escritorio. Bitacora
separa Eventos y Totales por colaborador en pestanas de ancho completo; en movil
se mantiene el desplazamiento de la pagina y de cada tabla.

Los PDF utilizan el logotipo ASISTO sin submarca en encabezados y pies.

Pruebas: `node --test server/csv-export.test.js server/report-schedules-pdf.test.js`.
