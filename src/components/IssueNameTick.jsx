import { useEffect, useRef, useState } from 'react';

const LABEL_WIDTH = 104;
const LABEL_HEIGHT = 22;
const COPY_GAP = 32;
const STILL = { overflow: false, distance: 0, duration: 0 };

export function getIssueNameMotion(textWidth, availableWidth) {
  if (!Number.isFinite(textWidth) || !Number.isFinite(availableWidth) || availableWidth <= 0 || textWidth <= availableWidth + 1) return STILL;
  const distance = Math.ceil(textWidth) + COPY_GAP;
  return { overflow: true, distance, duration: Math.max(8, distance / 24) };
}

export default function IssueNameTick({ x = 0, y = 0, payload, fill = 'currentColor' }) {
  const name = String(payload?.value ?? '').replace(/\s+/g, ' ').trim();
  const windowRef = useRef(null);
  const nameRef = useRef(null);
  const [motion, setMotion] = useState(STILL);

  useEffect(() => {
    let disposed = false;
    const measure = () => {
      if (disposed || !windowRef.current || !nameRef.current) return;
      const next = getIssueNameMotion(nameRef.current.getBoundingClientRect().width, windowRef.current.clientWidth);
      setMotion(previous => previous.overflow === next.overflow && previous.distance === next.distance ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (windowRef.current) observer?.observe(windowRef.current);
    if (nameRef.current) observer?.observe(nameRef.current);
    document.fonts?.ready?.then(measure);
    return () => { disposed = true; observer?.disconnect(); };
  }, [name]);

  if (!name || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return <g className="issue-name-axis-tick">
    <foreignObject x={x - LABEL_WIDTH} y={y - LABEL_HEIGHT / 2} width={LABEL_WIDTH} height={LABEL_HEIGHT} overflow="hidden">
      <div ref={windowRef} xmlns="http://www.w3.org/1999/xhtml" className={`issue-name-window${motion.overflow ? ' is-overflowing' : ''}`}
        role="img" aria-label={name} title={name} tabIndex={motion.overflow ? 0 : undefined} style={{ color: fill }}>
        <span className={`issue-name-track${motion.overflow ? ' is-scrolling' : ''}`} aria-hidden="true"
          style={{ '--issue-name-travel': `-${motion.distance}px`, '--issue-name-duration': `${motion.duration}s`, '--issue-name-gap': `${COPY_GAP}px` }}>
          <span ref={nameRef} className="issue-name-text">{name}</span>
          {motion.overflow && <span className="issue-name-copy">{name}</span>}
        </span>
      </div>
    </foreignObject>
  </g>;
}
