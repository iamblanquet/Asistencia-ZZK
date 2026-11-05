import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Fingerprint, Loader2, RefreshCw, Search, X } from 'lucide-react';
import FingerSelector, { FINGER_NAMES } from './FingerSelector';

const terminal = new Set(['completed', 'cancelled', 'timeout', 'failed', 'needs_attention']);
const labels = { queued: 'En espera', checking: 'Comprobando', waiting: 'Esperando captura', verifying: 'Verificando',
  completed: 'Huella registrada', cancelled: 'Cancelado', timeout: 'Tiempo agotado', failed: 'No se pudo registrar', needs_attention: 'Revisión necesaria' };

export default function FingerprintEnrollment({ device, employees, initialEmployeeId = '', getJson, apiRequest, onClose, onSaved }) {
  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const [createEmployee, setCreateEmployee] = useState(false);
  const [name, setName] = useState('');
  const [finger, setFinger] = useState('');
  const [inspection, setInspection] = useState(null);
  const [job, setJob] = useState(null);
  const [consent, setConsent] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(true);
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(null);
  const refreshed = useRef('');
  const existingEmployeeId = useRef(initialEmployeeId);
  const dialog = useRef(null);
  const active = Boolean(job && !terminal.has(job.status));
  const query = `deviceId=${encodeURIComponent(device.id)}`;

  useEffect(() => {
    const previous = document.activeElement;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    if (!recovering) dialog.current?.querySelector('button:not(:disabled),input:not(:disabled)')?.focus();
  }, [recovering]);

  useEffect(() => {
    let stopped = false;
    getJson(`/api/device/enrollments?${query}`).then(payload => {
      if (stopped) return;
      if (payload.job && (!terminal.has(payload.job.status) || payload.job.status === 'needs_attention')) {
        setJob(payload.job);
        setEmployeeId(payload.job.employeeId);
        setCreateEmployee(Boolean(payload.job.result?.createEmployee));
        setFinger(String(payload.job.fingerIndex));
      }
    }).catch(err => { if (!stopped) setError(err.message); })
      .finally(() => { if (!stopped) setRecovering(false); });
    return () => { stopped = true; };
  }, [device.id]);

  useEffect(() => {
    if (!job || terminal.has(job.status)) return;
    let stopped = false;
    let timer;
    async function poll() {
      try {
        const payload = await getJson(`/api/device/enrollments/${job.id}?${query}`);
        if (stopped) return;
        setJob(payload.job);
        if (payload.job.employeeId) {
          setEmployeeId(payload.job.employeeId);
          existingEmployeeId.current = payload.job.employeeId;
        }
        setError('');
        if (terminal.has(payload.job.status)) {
          setConsent(false);
          setConfirmed(false);
          if (payload.job.status === 'completed') {
            setInspection(previous => ({ exists: true, employee: previous?.employee || { employeeId: payload.job.employeeId, name },
              occupiedSlots: [...new Set([...(previous?.occupiedSlots || []), payload.job.fingerIndex])] }));
            if (payload.job.result?.employeeCreated) setCreateEmployee(false);
          } else setInspection(null);
          if ((payload.job.status === 'completed' || payload.job.result?.employeeCreated) && refreshed.current !== payload.job.id) {
            refreshed.current = payload.job.id;
            onSaved();
          }
          return;
        }
      } catch (err) {
        if (!stopped) setError(`${err.message} El registro puede seguir activo en el reloj.`);
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    timer = setTimeout(poll, 500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id]);

  useEffect(() => {
    if (!active || !job?.deadline) { setSeconds(null); return; }
    const update = () => setSeconds(Math.max(0, Math.ceil((new Date(job.deadline) - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, job?.deadline]);

  function reset() {
    setInspection(null); setFinger(''); setConsent(false); setConfirmed(false); setJob(null); setError('');
  }
  async function prepareNew() {
    if (!createEmployee) existingEmployeeId.current = employeeId;
    setCreateEmployee(true); reset(); setEmployeeId(''); setBusy(true);
    try {
      const payload = await getJson(`/api/device/enrollment-next-id?${query}`);
      if (!/^[1-9]\d{0,8}$/.test(payload.employeeId)) throw new Error('No se pudo obtener un ID libre.');
      setEmployeeId(payload.employeeId);
      setInspection({ exists: false, occupiedSlots: [] });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function inspect() {
    setBusy(true); setError(''); setInspection(null); setFinger(''); setConsent(false); setConfirmed(false);
    try {
      const payload = await getJson(`/api/device/fingerprints?${query}&employeeId=${encodeURIComponent(employeeId)}`);
      setInspection(payload);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); setError('');
    try {
      const payload = await apiRequest(`/api/device/enrollments?${query}`, { method: 'POST', body: JSON.stringify({
        employeeId: createEmployee ? undefined : employeeId, fingerIndex: Number(finger), createEmployee, name, consent, confirmed,
      }) });
      setJob(payload.job);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true); setError('');
    try {
      const payload = await apiRequest(`/api/device/enrollments/${job.id}/cancel?${query}`, { method: 'POST' });
      setJob(payload.job);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const validEmployee = inspection && (createEmployee ? !inspection.exists && name.trim() : inspection.exists);
  const canStart = validEmployee && finger !== '' && !inspection.occupiedSlots.includes(Number(finger)) && consent && confirmed && !busy && !recovering && !active;

  function keyboard(event) {
    if (event.key === 'Escape' && !active && !busy) onClose();
    if (event.key === 'Tab') {
      const available = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
      const controls = available.filter(control => control.type !== 'radio' || control === (
        available.find(candidate => candidate.type === 'radio' && candidate.name === control.name && candidate.checked)
        || available.find(candidate => candidate.type === 'radio' && candidate.name === control.name)
      ));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  return <div className="modal-overlay fingerprint-enrollment-overlay" onClick={() => { if (!active && !busy) onClose(); }}>
    <section ref={dialog} className="modal-content enrollment-modal" role="dialog" aria-modal="true" aria-labelledby="enrollment-title" onClick={event => event.stopPropagation()} onKeyDown={keyboard}>
      <div className="enrollment-heading">
        <h3 id="enrollment-title"><Fingerprint size={20} /> Registrar huella</h3>
        <button type="button" className="enrollment-close" aria-label="Cerrar registro de huella" title="Cerrar" onClick={onClose} disabled={active || busy}><X size={20} /></button>
      </div>
      <div className="enrollment-target"><strong>{device.name}</strong><span>{device.ip}:{device.port || 4370}</span></div>
      <fieldset disabled={active || busy || recovering} className="enrollment-fields">
        <div className="enrollment-mode" role="tablist" aria-label="Tipo de colaborador">
          <button type="button" role="tab" aria-selected={!createEmployee} onClick={() => { setCreateEmployee(false); setEmployeeId(existingEmployeeId.current); reset(); }}>Colaborador existente</button>
          <button type="button" role="tab" aria-selected={createEmployee} onClick={prepareNew}>Nuevo colaborador</button>
        </div>
        <div className="enrollment-id-row">
          <div className="field"><label htmlFor="enrollment-id">{createEmployee ? 'ID automático' : 'ID de colaborador'}</label>
            <input id="enrollment-id" autoFocus inputMode="numeric" maxLength={9} readOnly={createEmployee} list={createEmployee ? undefined : 'enrollment-employee-options'} value={employeeId} onChange={event => { setEmployeeId(event.target.value); existingEmployeeId.current = event.target.value; reset(); }} />
            <datalist id="enrollment-employee-options">{employees.map(employee => <option key={employee.employeeId} value={employee.employeeId}>{employee.name}</option>)}</datalist>
          </div>
          {createEmployee
            ? <button type="button" className="btn-action btn-action-secondary" onClick={prepareNew}><RefreshCw size={16} /> Actualizar ID</button>
            : <button type="button" className="btn-action btn-action-secondary" onClick={inspect} disabled={!/^[1-9]\d{0,8}$/.test(employeeId)}><Search size={16} /> Comprobar</button>}
        </div>
        {createEmployee && <div className="field"><label htmlFor="enrollment-name">Nombre completo</label><input id="enrollment-name" value={name} maxLength={24} onChange={event => { setName(event.target.value); setConfirmed(false); }} /></div>}
        {inspection && <div className="enrollment-employee-result">{inspection.exists ? `${inspection.employee.name} · ID ${employeeId}` : `ID ${employeeId} disponible para un colaborador nuevo`}</div>}
        <FingerSelector value={finger} occupiedSlots={inspection?.occupiedSlots} disabled={!validEmployee}
          onChange={value => { setFinger(value); setConfirmed(false); setJob(null); }} />
        <label className="enrollment-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />La persona está presente y autoriza el registro de su huella.</label>
        <label className="enrollment-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmo el colaborador, dedo y biométrico seleccionados.</label>
      </fieldset>
      {error && <div className="enrollment-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
      {job && <div className={`enrollment-feedback ${job.status === 'completed' ? 'is-success' : ''}`} role="status" aria-live="polite">
        {active ? <Loader2 size={21} className="spin" /> : job.status === 'completed' ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}
        <div><strong>{labels[job.status] || job.status}</strong><p>{job.message}</p>
          <span>ID {job.employeeId || 'pendiente'} · {FINGER_NAMES[job.fingerIndex]}{job.status === 'waiting' && seconds !== null ? ` · ${seconds} s` : ''}</span>
          {job.result?.employeeCreated && job.status !== 'completed' && <p>El colaborador fue creado en el reloj; su huella aún no está confirmada.</p>}
        </div>
      </div>}
      <div className="enrollment-actions">
        {active ? <button type="button" className="btn-action btn-action-secondary" disabled={busy || job.cancelRequested} onClick={cancel}><X size={16} />{job.cancelRequested ? 'Cancelando...' : 'Cancelar captura'}</button>
          : <button type="button" className="btn-action btn-action-primary" disabled={!canStart} onClick={start}><Fingerprint size={17} />{busy || recovering ? 'Comprobando...' : 'Iniciar registro'}</button>}
      </div>
    </section>
  </div>;
}
