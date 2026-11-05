import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileUp, History, KeyRound, Loader2, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';

const fingerNames = ['Meñique izquierdo', 'Anular izquierdo', 'Medio izquierdo', 'Índice izquierdo', 'Pulgar izquierdo', 'Pulgar derecho', 'Índice derecho', 'Medio derecho', 'Anular derecho', 'Meñique derecho'];
const actionNames = { export: 'Descarga', preview: 'Vista previa', restore: 'Recuperación' };
const statusNames = { running: 'En proceso', success: 'Completado', failed: 'Falló', needs_attention: 'Revisar reloj' };
const dateLabel = value => new Date(value).toLocaleString('es-MX');

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo abrir el archivo.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

export default function BiometricBackups({ device, apiRequest, getJson, onClose, onSaved }) {
  const [mode, setMode] = useState('export');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [keyFilename, setKeyFilename] = useState('');
  const [archive, setArchive] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [employeeId, setEmployeeId] = useState('');
  const [confirmationId, setConfirmationId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const dialog = useRef(null);
  const mounted = useRef(true);
  const endpoint = `/api/device/biometric-backups`;
  const query = `?deviceId=${encodeURIComponent(device.id)}`;
  const selected = preview?.employees.find(item => item.employeeId === employeeId);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    void loadHistory();
    dialog.current?.querySelector('button')?.focus();
    return () => { mounted.current = false; previous?.focus?.(); };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => {
      setPreview(null); setConfirmed(false); setConfirmationId(''); setError('La vista previa venció. Consulta de nuevo el archivo.');
    }, Math.max(0, new Date(preview.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    if (!busy) return;
    const prevent = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [busy]);

  function invalidate() { setPreview(null); setEmployeeId(''); setConfirmationId(''); setConfirmed(false); setResult(null); }
  function switchMode(next) {
    setMode(next); setRecoveryKey(''); setKeyFilename(''); setError(''); setArchive(''); setFileName(''); invalidate();
  }
  async function loadHistory() {
    setHistoryBusy(true); setHistoryError('');
    try { const data = await getJson(endpoint + '/history' + query); if (mounted.current) setHistory(data.actions); }
    catch { if (mounted.current) setHistoryError('No se pudo cargar el historial.'); }
    finally { if (mounted.current) setHistoryBusy(false); }
  }
  async function chooseFile(event) {
    invalidate(); setArchive(''); setFileName(''); setError('');
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zkbio') || file.size > 16 * 1024 * 1024 || !file.size) {
      setError('Selecciona un archivo .zkbio de hasta 16 MB.'); event.target.value = ''; return;
    }
    setBusy('file');
    try { const encoded = await fileBase64(file); if (mounted.current) { setArchive(encoded); setFileName(file.name); } }
    catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(''); }
  }
  function saveDownload(data) {
    const url = URL.createObjectURL(data.blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = data.filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function download(event, keyOnly = false) {
    event?.preventDefault(); setBusy(keyOnly ? 'key' : 'export'); setError(''); setResult(null);
    try {
      const data = await apiRequest(endpoint + (keyOnly ? '/recovery-key' : '/download') + query, { method: keyOnly ? 'GET' : 'POST', responseType: 'blob',
        ...(keyOnly ? {} : { body: JSON.stringify({ confirmed: true }) }) });
      saveDownload(data);
      if (mounted.current) setResult({ message: keyOnly ? 'Clave de recuperación descargada. Guárdala separada del respaldo.' : 'Respaldo cifrado generado y verificado. Sin contraseña manual.', filename: data.filename });
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) { setBusy(''); void loadHistory(); } }
  }
  async function inspect(event) {
    event.preventDefault(); invalidate(); setBusy('preview'); setError('');
    try {
      const data = await apiRequest(endpoint + '/preview' + query, { method: 'POST', body: JSON.stringify({ archive, recoveryKey: recoveryKey || undefined }) });
      if (mounted.current) setPreview(data);
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) { setBusy(''); void loadHistory(); } }
  }
  async function restore(event) {
    event.preventDefault(); setBusy('restore'); setError('');
    try {
      const data = await apiRequest(endpoint + '/restore' + query, { method: 'POST', body: JSON.stringify({
        archive, recoveryKey: recoveryKey || undefined, token: preview.token, employeeId, confirmationId, confirmed,
      }) });
      if (mounted.current) { setResult(data); setPreview(null); setConfirmed(false); setConfirmationId(''); setRecoveryKey(''); setKeyFilename(''); }
      void onSaved();
    } catch (err) {
      if (mounted.current) { setError(err.message); setPreview(null); setConfirmed(false); setConfirmationId(''); }
    } finally { if (mounted.current) { setBusy(''); void loadHistory(); } }
  }
  async function chooseKey(event) {
    invalidate(); setRecoveryKey(''); setKeyFilename(''); setError('');
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.size || file.size > 16384) { setError('Selecciona un archivo de clave .zkkey o .pem de hasta 16 KB.'); event.target.value = ''; return; }
    setBusy('file');
    try { const text = await file.text(); if (mounted.current) { setRecoveryKey(text); setKeyFilename(file.name); } }
    catch { if (mounted.current) setError('No se pudo leer el archivo de clave.'); }
    finally { if (mounted.current) setBusy(''); }
  }
  function keydown(event) {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <div className="modal-overlay biometric-backup-overlay" onClick={() => { if (!busy) onClose(); }}>
    <section ref={dialog} className="modal-content enrollment-modal biometric-backup-modal" role="dialog" aria-modal="true" aria-labelledby="backup-title" onClick={event => event.stopPropagation()} onKeyDown={keydown}>
      <div className="enrollment-heading"><h3 id="backup-title"><ShieldCheck size={20} />Respaldos biométricos</h3>
        <button type="button" className="enrollment-close" title="Cerrar" aria-label="Cerrar respaldos" onClick={onClose} disabled={Boolean(busy)}><X size={20} /></button>
      </div>
      <div className="enrollment-target"><strong>{device.name}</strong><span>{device.ip}:{device.port || 4370}</span></div>
      <div className="enrollment-mode" role="tablist" aria-label="Operación de respaldo">
        <button type="button" role="tab" aria-selected={mode === 'export'} disabled={Boolean(busy)} onClick={() => switchMode('export')}><Download size={15} /> Descargar respaldo</button>
        <button type="button" role="tab" aria-selected={mode === 'import'} disabled={Boolean(busy)} onClick={() => switchMode('import')}><Upload size={15} /> Recuperar usuario</button>
      </div>
      {mode === 'export' ? <form onSubmit={download} className="backup-form">
        <div className="backup-security-note"><ShieldCheck size={17} /><span>Cifrado automático. Conserva la clave de recuperación por separado; será necesaria si se pierde este servidor.</span></div>
        <div className="enrollment-actions"><button type="button" className="btn-action btn-action-secondary" disabled={Boolean(busy)} onClick={event => download(event, true)}><KeyRound size={16} /> Descargar clave</button><button type="submit" className="btn-action btn-action-primary" disabled={Boolean(busy)}><Download size={16} /> Descargar .zkbio</button></div>
      </form> : <div className="backup-form">
        <form onSubmit={inspect}>
          <fieldset className="enrollment-fields" disabled={Boolean(busy)}>
            <div className="field"><label htmlFor="backup-file">Archivo cifrado (.zkbio)</label><input id="backup-file" type="file" accept=".zkbio" onChange={chooseFile} />{fileName && <span className="backup-filename">{fileName}</span>}</div>
            <details className="backup-external-key"><summary>Clave de otro servidor o instalación</summary><div className="field"><label htmlFor="backup-recovery-key">Archivo de clave de recuperación (opcional)</label><input id="backup-recovery-key" type="file" accept=".zkkey,.pem" onChange={chooseKey} />{keyFilename && <span className="backup-filename">{keyFilename}</span>}</div></details>
          </fieldset>
          <div className="enrollment-actions"><button type="submit" className="btn-action btn-action-secondary" disabled={Boolean(busy) || !archive}><FileUp size={16} /> Consultar respaldo</button></div>
        </form>
        {preview && <form className="backup-recovery" onSubmit={restore}>
          <dl className="backup-metadata"><div><dt>Fecha</dt><dd>{dateLabel(preview.backup.createdAt)}</dd></div><div><dt>Serie</dt><dd>{preview.backup.device.serial}</dd></div><div><dt>Modelo</dt><dd>{preview.backup.device.model}</dd></div><div><dt>Contenido</dt><dd>{preview.backup.users} usuarios · {preview.backup.fingerprints} huellas</dd></div></dl>
          <fieldset className="enrollment-fields" disabled={Boolean(busy)}>
            <div className="field"><label htmlFor="backup-employee">Usuario a recuperar</label><select id="backup-employee" value={employeeId} onChange={event => { setEmployeeId(event.target.value); setConfirmed(false); setConfirmationId(''); }}><option value="">Seleccionar usuario</option>
              {preview.employees.map(employee => <option key={employee.employeeId} value={employee.employeeId} disabled={!employee.eligible}>ID {employee.employeeId} · {employee.name || `Colaborador ${employee.employeeId}`}{employee.eligible ? ` · ${employee.fingerprintCount} huellas` : ` · ${employee.reason}`}</option>)}
            </select></div>
            {!preview.employees.some(employee => employee.eligible) && <div className="backup-security-note"><ShieldCheck size={17} /><span>No hay usuarios ausentes recuperables en este respaldo.</span></div>}
            {selected?.eligible && <><div className="device-user-summary"><strong>{selected.name || `Colaborador ${selected.employeeId}`} · ID {selected.employeeId}</strong><span>{selected.fingers.map(finger => fingerNames[finger]).join(', ')}</span></div>
              <div className="field"><label htmlFor="backup-confirm-id">Escribe el ID {employeeId} para confirmar</label><input id="backup-confirm-id" inputMode="numeric" autoComplete="off" value={confirmationId} onChange={event => setConfirmationId(event.target.value)} /></div>
              <label className="enrollment-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmo recuperar este usuario y sus huellas en {device.name} ({device.ip}).</label></>}
          </fieldset>
          <div className="enrollment-actions"><button type="submit" className="btn-action btn-action-primary" disabled={Boolean(busy) || !selected?.eligible || !confirmed || confirmationId !== employeeId}><Upload size={16} /> Recuperar en el reloj</button></div>
        </form>}
      </div>}
      {busy && <div className="enrollment-feedback" role="status"><Loader2 size={19} className="spin" /><span>{busy === 'restore' ? 'Cargando y verificando usuario y huellas...' : busy === 'export' ? 'Leyendo, cifrando y verificando el respaldo...' : busy === 'key' ? 'Preparando clave de recuperación...' : busy === 'preview' ? 'Verificando archivo y biométrico...' : 'Abriendo archivo...'}</span></div>}
      {error && <div className="enrollment-error" role="alert"><AlertTriangle size={18} /><span>{error}</span></div>}
      {result && <div className="enrollment-feedback is-success" role="status"><CheckCircle2 size={20} /><div><strong>{result.message}</strong>{result.filename && <span className="backup-filename">{result.filename}</span>}{result.employee && <span>ID {result.employee.employeeId} · {result.fingerprintCount} huellas verificadas</span>}</div></div>}
      <section className="backup-history" aria-label="Historial de respaldos"><div className="backup-history-heading"><h4><History size={16} />Actividad reciente</h4><button type="button" className="enrollment-close" title="Actualizar historial" aria-label="Actualizar historial de respaldos" disabled={historyBusy || Boolean(busy)} onClick={loadHistory}><RefreshCw size={16} className={historyBusy ? 'spin' : ''} /></button></div>
        {historyError ? <p role="status">{historyError}</p> : history.length ? <ul>{history.map(item => <li key={item.id}><span><strong>{item.details.type === 'recovery-key' ? 'Clave de recuperación' : actionNames[item.action]}{item.employeeId ? ` · ID ${item.employeeId}` : ''}</strong><time dateTime={item.createdAt}>{dateLabel(item.createdAt)}</time></span><span className={`backup-audit-status is-${item.status}`}>{statusNames[item.status] || item.status}</span></li>)}</ul> : <p>{historyBusy ? 'Cargando...' : 'Sin operaciones registradas.'}</p>}
      </section>
    </section>
  </div>;
}
