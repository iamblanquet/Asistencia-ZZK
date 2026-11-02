import React from 'react';

/**
 * Ícono / Favicon oficial de ASISTO (Cuadrado redondeado Grafito #1B1F24 con A blanca y acento Naranja ITZ #FF7A00)
 */
export function AsistoIcon({ size = 36, className = '', style = {} }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="ASISTO Icon"
    >
      <rect width="120" height="120" rx="26" fill="#1B1F24" border="1px solid rgba(255,255,255,0.1)" />
      <path d="M53.5 22 H66.5 L100 95 H85.5 L60 38.5 L34.5 95 H20 L53.5 22 Z" fill="#FFFFFF" />
      <path d="M49.5 64 H69.5 L75 76 H55.5 L47 95 H34.5 L49.5 64 Z" fill="#FF7A00" />
    </svg>
  );
}

/**
 * Logotipo oficial ASISTO By ITZ | OIL & GAS
 * @param {'light' | 'dark' | 'on-orange'} variant - 'light' para fondos claros (texto grafito #1B1F24), 'dark' para fondos oscuros (texto blanco #FFFFFF)
 */
export function AsistoLogo({
  variant = 'light',
  height = 56,
  showSubtitle = true,
  className = '',
  style = {},
}) {
  const mainColor = variant === 'dark' || variant === 'on-orange' ? '#FFFFFF' : '#1B1F24';
  const accentColor = variant === 'on-orange' ? '#FFE0C2' : '#FF7A00';
  const viewBoxHeight = showSubtitle ? 128 : 84;
  const aspect = 430 / viewBoxHeight;
  const width = Math.round(height * aspect);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 430 ${viewBoxHeight}`}
      width={width}
      height={height}
      className={className}
      style={{ display: 'block', ...style }}
      aria-label="ASISTO By ITZ | OIL & GAS"
    >
      {/* A estilizada */}
      <path d="M40 16 H51 L78 74 H66 L45.5 29.5 L25 74 H13 L40 16 Z" fill={mainColor} />
      <path d="M36.5 50 H53.5 L58 60 H41.5 L35 74 H25 L36.5 50 Z" fill={accentColor} />
      {/* SISTO */}
      <text
        x="82"
        y="74"
        fill={mainColor}
        style={{
          fontFamily: "'Montserrat', sans-serif",
          fontWeight: 700,
          fontSize: '72px',
          letterSpacing: '2px',
        }}
      >
        SISTO
      </text>

      {showSubtitle && (
        <g>
          <text
            x="158"
            y="108"
            fill={mainColor}
            style={{
              fontFamily: "'Montserrat', sans-serif",
              fontWeight: 600,
              fontStyle: 'italic',
              fontSize: '18px',
            }}
          >
            By
          </text>
          {/* Monograma ITZ */}
          <g fill={mainColor}>
            <rect x="192" y="90" width="4.5" height="22" rx="0.5" />
            <path d="M199 90 H236 V94 H226 L213 108 H236 V112 H206 V108 L219 94 H209 V112 H204.5 V94 H199 V90 Z" />
          </g>
          {/* Línea divisoria */}
          <line x1="247" y1="82" x2="247" y2="118" stroke={mainColor} strokeWidth="2" />
          {/* Ícono Oil & Gas */}
          <g
            transform="translate(274, 80)"
            fill="none"
            stroke={mainColor}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 14 C8 10 12 4 12 4 C12 4 16 10 16 14 C16 16.5 14.2 18.5 12 18.5 C9.8 18.5 8 16.5 8 14 Z" />
            <path d="M18 18.5 H26 V11 L22 9 V18.5" />
            <circle cx="23" cy="5" r="2" />
            <path d="M4 18.5 H28" />
          </g>
          <rect x="255" y="105" width="2.2" height="9" fill={accentColor} />
          <text
            x="261"
            y="113"
            fill={mainColor}
            style={{
              fontFamily: "'Montserrat', sans-serif",
              fontWeight: 600,
              fontSize: '9.5px',
              letterSpacing: '3.5px',
            }}
          >
            OIL &amp; GAS
          </text>
        </g>
      )}
    </svg>
  );
}

/**
 * Elementos gráficos / Iconografía sugerida del Manual de Identidad Visual
 * Bicolor: Trazo principal en currentColor (Grafito #1B1F24 o Blanco) + Acento Naranja ITZ (#FF7A00)
 */

// 1. Personal (3 personas con silueta central en Naranja ITZ #FF7A00)
export function IconPersonal({ size = 20, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      {/* Persona izquierda */}
      <circle cx="5.5" cy="8.5" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M1.8 18.5 C1.8 15.8 3.4 14.2 5.5 14.2 C6.3 14.2 7 14.4 7.6 14.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {/* Persona derecha */}
      <circle cx="18.5" cy="8.5" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M22.2 18.5 C22.2 15.8 20.6 14.2 18.5 14.2 C17.7 14.2 17 14.4 16.4 14.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {/* Persona central (cabeza borde, torso relleno Naranja ITZ) */}
      <circle cx="12" cy="7" r="2.8" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M7.2 19.2 C7.2 15.9 9.3 13.8 12 13.8 C14.7 13.8 16.8 15.9 16.8 19.2 Z"
        fill="#FF7A00"
      />
    </svg>
  );
}

// 2. Asistencia (Calendario con check en Naranja ITZ #FF7A00)
export function IconAsistencia({ size = 20, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <path
        d="M19 11V6.5C19 5.4 18.1 4.5 17 4.5H5.5C4.4 4.5 3.5 5.4 3.5 6.5V18C3.5 19.1 4.4 20 5.5 20H11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <line x1="7.5" y1="2.5" x2="7.5" y2="6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="15" y1="2.5" x2="15" y2="6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="3.5" y1="9" x2="19" y2="9" stroke="currentColor" strokeWidth="1.8" />
      {/* Check Naranja ITZ */}
      <path
        d="M12.5 16.2 L15.2 18.8 L20.8 13.2"
        stroke="#FF7A00"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 3. Entradas / Salidas (Reloj con manecillas en Naranja ITZ #FF7A00)
export function IconEntradasSalidas({ size = 20, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 7 V12.2 L15.5 14.5"
        stroke="#FF7A00"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 4. Reportes (Gráfica de barras con barra mayor en Naranja ITZ #FF7A00)
export function IconReportes({ size = 20, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <rect x="3.5" y="13" width="4" height="7" rx="0.8" stroke="currentColor" strokeWidth="1.7" />
      <rect x="10" y="9" width="4" height="11" rx="0.8" stroke="currentColor" strokeWidth="1.7" />
      <rect x="16.5" y="4" width="4.5" height="16.8" rx="0.8" fill="#FF7A00" />
    </svg>
  );
}

// 5. Incidencias (Calendario con reloj en Naranja ITZ #FF7A00)
export function IconIncidencias({ size = 20, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <path
        d="M19 10.5V6.5C19 5.4 18.1 4.5 17 4.5H5.5C4.4 4.5 3.5 5.4 3.5 6.5V18C3.5 19.1 4.4 20 5.5 20H10.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <line x1="7.5" y1="2.5" x2="7.5" y2="6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="15" y1="2.5" x2="15" y2="6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="3.5" y1="9" x2="19" y2="9" stroke="currentColor" strokeWidth="1.8" />
      {/* Reloj de incidencia en Naranja ITZ */}
      <circle cx="16.5" cy="16.5" r="4.5" stroke="#FF7A00" strokeWidth="1.9" />
      <path
        d="M16.5 14.2 V16.6 L18.2 17.6"
        stroke="#FF7A00"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 6. Configuración (Engranaje con núcleo en Naranja ITZ #FF7A00)
export function IconConfiguracion({ size = 20, className = '' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      className={className}
    >
      <path
        d="M12 2.8 L13.4 4.8 L15.8 4.4 L16.4 6.7 L18.8 7.4 L18.3 9.8 L20.2 11.2 L18.8 13.2 L19.8 15.5 L17.6 16.6 L17.4 19 L15 18.9 L13.5 20.8 L11.5 19.5 L9.3 20.6 L8.2 18.4 L5.8 18.2 L5.9 15.8 L4 14.3 L5.3 12.2 L4.3 10 L6.5 8.9 L6.7 6.5 L9.1 6.6 L10.6 4.7 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.5" stroke="#FF7A00" strokeWidth="2.2" />
    </svg>
  );
}

/**
 * Onda decorativa curva Naranja ITZ (#FF7A00) y Grafito (#1B1F24)
 * Tal como aparece en el Ejemplo de Aplicación (Login Desktop / Mobile) del Manual de Identidad Visual
 */
export function LoginWaveDecoration() {
  return (
    <svg
      className="login-wave-svg"
      viewBox="0 0 500 800"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {/* Banda Naranja ITZ (#FF7A00) */}
      <path
        d="M500 0 L430 0 C395 260 280 540 90 800 L500 800 Z"
        fill="#FF7A00"
      />
      {/* Esquina inferior derecha Grafito (#1B1F24) */}
      <path
        d="M500 220 C455 440 365 650 220 800 L500 800 Z"
        fill="#1B1F24"
      />
    </svg>
  );
}
