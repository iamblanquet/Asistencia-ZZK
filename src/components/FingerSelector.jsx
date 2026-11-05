import { useId } from 'react';
import { Check, Fingerprint } from 'lucide-react';

export const FINGER_NAMES = ['Meñique izquierdo', 'Anular izquierdo', 'Medio izquierdo', 'Índice izquierdo', 'Pulgar izquierdo',
  'Pulgar derecho', 'Índice derecho', 'Medio derecho', 'Anular derecho', 'Meñique derecho'];

const outline = 'M59 232 L57 209 C43 198 29 176 28 155 L28 94 C28 87 33 82 39 82 C46 82 50 88 50 94 L50 121 L55 121 L55 56 C55 48 60 42 67 42 C74 42 79 48 79 56 L79 115 L84 115 L84 40 C84 31 89 25 97 25 C105 25 110 32 110 40 L110 112 L115 112 L115 60 C115 52 120 46 128 46 C136 46 141 53 141 61 L141 139 L157 119 C164 111 173 111 179 117 C185 123 184 132 179 140 L162 166 C158 186 148 202 136 211 L136 232 Z';
// Geometry is shared by the mirrored hands; protocol slots retain their original order.
const digits = [
  { x: 27, y: 81, width: 25, height: 58, path: 'M28 139 L28 94 C28 87 33 82 39 82 C46 82 50 88 50 94 L50 139 Z' },
  { x: 54, y: 41, width: 27, height: 91, path: 'M55 132 L55 56 C55 48 60 42 67 42 C74 42 79 48 79 56 L79 132 Z' },
  { x: 83, y: 24, width: 28, height: 105, path: 'M84 129 L84 40 C84 31 89 25 97 25 C105 25 110 32 110 40 L110 129 Z' },
  { x: 114, y: 45, width: 29, height: 99, path: 'M115 144 L115 60 C115 52 120 46 128 46 C136 46 141 53 141 61 L141 144 Z' },
  { x: 153, y: 112, width: 28, height: 60, rotation: 31, path: 'M141 139 L157 119 C164 111 173 111 179 117 C185 123 184 132 179 140 L162 166 L149 173 L137 155 Z' },
];

export default function FingerSelector({ value, occupiedSlots = [], disabled = false, onChange }) {
  const id = useId();
  const selected = value === '' ? -1 : Number(value);
  const selectedName = FINGER_NAMES[selected];
  const occupied = new Set(occupiedSlots);
  const status = selectedName ? `${selectedName}${occupied.has(selected) ? ' · Registrado' : ''}` : 'Sin seleccionar';

  return <fieldset className="finger-picker" disabled={disabled}>
    <legend>Dedo</legend>
    <div className={`finger-picker-selection${selectedName ? ' has-selection' : ''}`} role="status" aria-live="polite">
      {occupied.has(selected) ? <Check size={15} /> : <Fingerprint size={15} />}
      <span>{status}</span>
    </div>
    <div className="finger-picker-hands">
      {[false, true].map(right => {
        const slots = right ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4];
        return <div key={String(right)} className="finger-picker-hand">
          <span className="finger-picker-side">{right ? 'Derecha' : 'Izquierda'}</span>
          <div className="finger-hand-diagram">
            <svg viewBox="0 0 210 238" aria-hidden="true" focusable="false">
              <g transform={right ? 'translate(210 0) scale(-1 1)' : undefined}>
                <path className="finger-hand-outline" d={outline} />
                {digits.map((digit, position) => {
                  const slot = right ? 9 - position : position;
                  return <path key={slot} d={digit.path} className={`finger-hand-digit${occupied.has(slot) ? ' is-registered' : selected === slot ? ' is-selected' : ''}`} />;
                })}
                <path className="finger-hand-crease" d="M55 152 C72 141 103 140 121 147 M58 170 C77 180 103 178 115 171 M132 153 C124 166 121 185 126 196" />
              </g>
            </svg>
            {slots.map(slot => {
              const digit = digits[right ? 9 - slot : slot];
              const registered = occupied.has(slot);
              const label = `${FINGER_NAMES[slot]}${registered ? ' (registrado)' : ''}`;
              return <label key={slot} className={`finger-option${registered ? ' is-registered' : ''}`} title={label}
                style={{ left: `${(right ? 210 - digit.x - digit.width : digit.x) / 210 * 100}%`, top: `${digit.y / 238 * 100}%`,
                  width: `${digit.width / 210 * 100}%`, height: `${digit.height / 238 * 100}%`,
                  transform: digit.rotation ? `rotate(${right ? -digit.rotation : digit.rotation}deg)` : undefined }}>
                <input type="radio" name={`${id}-finger`} value={slot} aria-label={label} checked={selected === slot}
                  disabled={registered} onChange={() => onChange(String(slot))} />
                <span className="finger-option-marker" aria-hidden="true">{registered ? <Check size={14} /> : <Fingerprint size={14} />}</span>
              </label>;
            })}
          </div>
        </div>;
      })}
    </div>
    <div className="finger-picker-legend" aria-hidden="true">
      <span><Fingerprint size={13} /> Disponible</span>
      <span className="is-selected"><Fingerprint size={13} /> Seleccionado</span>
      <span className="is-registered"><Check size={13} /> Registrado</span>
    </div>
  </fieldset>;
}
