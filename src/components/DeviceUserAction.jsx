import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Edit, Loader2, RefreshCw, Trash2, X } from 'lucide-react';

export default function DeviceUserAction({ device, employee, action, getJson, apiRequest, onClose, onSaved }) {
  const [preview, setPreview] = useState(null);
  const [name, setName] = useState('');
  const [confirmationId, setConfirmationId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const dialog = useRef(null);
  const mounted = useRef(true);
  const deleting = action === 'delete';
  const endpoint = `/api/device/users/${encodeURIComponent(employee.employeeId)}?deviceId=${encodeURIComponent(device.id)}`;

  useEffect(() => {
    const previous = document.activeElement;
    mounted.current = true;
    void inspect();
    return () => { mounted.current = false; previous?.focus?.(); };
  }, []);
  useEffect(() => { if (!busy) dialog.current?.querySelector('button:not(:disabled),input:not(:disabled)')?.focus(); }, [busy]);

  async function inspect() {
    setBusy(true); setPreview(null); setConfirmed(false); setConfirmationId(''); setError('');
    try {
      const data = await getJson(endpoint);
      if (mounted.current) { setPreview(data); setName(data.employee.name); }
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setWriting(true); setError('');
    try {
      const data = await apiRequest(endpoint, { method: deleting ? 'DELETE' : 'PUT', body: JSON.stringify({
        token: preview.token, confirmed, name: deleting ? undefined : name.trim(),
        confirmationId: deleting ? confirmationId : undefined, deleteFingerprints: deleting ? confirmed : undefined,
      }) });
      setResult(data); void onSaved();
    } catch (err) { setError(err.message); setPreview(null); setConfirmed(false); setConfirmationId(''); }
    finally { setBusy(false); setWriting(false); }
  }
  function keydown(event) {
    if (event.key === 'Escape' && !writing) onClose();
    if (event.key === 'Tab') {
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  const canSubmit = preview && confirmed && !busy && (deleting
    ? preview.canDelete && confirmationId === String(employee.employeeId)
    : name.trim() && new TextEncoder().encode(name.trim()).length <= 24 && name.trim() !== preview.employee.name);

  return <div className="modal-overlay device-user-action-overlay" onClick={() => { if (!writing) onClose(); }}>
    <section ref={dialog} className="modal-content enrollment-modal" role="dialog" aria-modal="true" aria-labelledby="device-user-title" onClick={event => event.stopPropagation()} onKeyDown={keydown}>
      <div className="enrollment-heading"><h3 id="device-user-title">{deleting ? <Trash2 size={20} /> : <Edit size={20} />}{deleting ? 'Eliminar del biométrico' : 'Editar nombre en biométrico'}</h3>
        <button type="button" className="enrollment-close" title="Cerrar" aria-label="Cerrar administración del usuario" onClick={onClose} disabled={writing}><X size={20} /></button>
      </div>
      <div className="enrollment-target"><strong>{device.name}</strong><span>{device.ip}:{device.port || 4370}</span></div>
      {result ? <>
        <div className="enrollment-feedback is-success" role="status"><CheckCircle2 size={21} /><div><strong>Operación verificada</strong><p>{result.message}</p><span>ID {employee.employeeId}</span></div></div>
        <div className="enrollment-actions"><button type="button" className="btn-action btn-action-secondary" onClick={onClose}>Cerrar</button></div>
      </> : <form onSubmit={submit}>
        {preview && <div className="device-user-summary"><strong>{preview.employee.name}</strong><span>ID {preview.employee.employeeId} · {preview.fingerprintCount} huellas · {preview.employee.role === 0 ? 'Usuario normal' : 'Usuario protegido'}</span></div>}
        {busy && <div className="enrollment-feedback" role="status"><Loader2 size={18} className="spin" /><span>{writing ? 'Aplicando y verificando en el reloj...' : 'Consultando usuario en el reloj...'}</span></div>}
        {error && <div className="enrollment-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
        {preview && <fieldset className="enrollment-fields" disabled={busy}>
          {deleting ? <>
            <div className="device-user-warning"><AlertTriangle size={18} /><span>Se eliminarán este usuario y sus huellas del reloj. La recuperación requiere un respaldo cifrado previo y su clave de recuperación. Su historial de asistencias se conserva.</span></div>
            {!preview.canDelete && <div className="enrollment-error" role="alert">No se permite eliminar usuarios con privilegios.</div>}
            <div className="field"><label htmlFor="device-user-confirmation">Escribe el ID {employee.employeeId} para confirmar</label><input id="device-user-confirmation" value={confirmationId} autoComplete="off" inputMode="numeric" onChange={event => setConfirmationId(event.target.value)} /></div>
          </> : <div className="field"><label htmlFor="device-user-name">Nombre en el biométrico</label><input id="device-user-name" value={name} maxLength={24} onChange={event => { setName(event.target.value); setConfirmed(false); }} /></div>}
          <label className="enrollment-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{deleting ? 'Confirmo eliminar del biométrico seleccionado este usuario y sus huellas.' : 'Confirmo cambiar el nombre de este usuario en el biométrico seleccionado.'}</label>
        </fieldset>}
        <div className="enrollment-actions">
          {!preview && !busy && <button type="button" className="btn-action btn-action-secondary" onClick={inspect}><RefreshCw size={16} /> Volver a consultar</button>}
          <button type="button" className="btn-action btn-action-secondary" onClick={onClose} disabled={writing}>Cancelar</button>
          <button type="submit" className={`btn-action ${deleting ? 'btn-device-delete' : 'btn-action-primary'}`} disabled={!canSubmit}>{deleting ? <Trash2 size={16} /> : <Edit size={16} />}{deleting ? 'Eliminar del equipo' : 'Guardar en el equipo'}</button>
        </div>
      </form>}
    </section>
  </div>;
}
