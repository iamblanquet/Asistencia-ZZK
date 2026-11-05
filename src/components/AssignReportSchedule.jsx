import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock, Loader2, RefreshCw, Save, X } from 'lucide-react';
import { dateLabel, resolveReportSchedule, todayInputValue } from '../utils/attendance';

export default function AssignReportSchedule({ device, employee, getJson, apiRequest, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [date, setDate] = useState(todayInputValue);
  const [groupId, setGroupId] = useState('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const mounted = useRef(true);
  const dialog = useRef(null);
  const endpoint = `/api/employees/${encodeURIComponent(employee.employeeId)}/report-schedule?deviceId=${encodeURIComponent(device.id)}`;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    mounted.current = true;
    void reload();
    dialog.current?.focus();
    return () => { mounted.current = false; document.body.style.overflow = previousOverflow; previousFocus?.focus?.(); };
  }, []);

  function close() {
    if (!saving && (!dirty || window.confirm('Descartar la asignacion sin guardar?'))) onClose();
  }
  async function reload() {
    if (dirty && !window.confirm('Descartar la asignacion sin guardar?')) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const result = await getJson(endpoint);
      if (!mounted.current) return;
      setData(result);
      setGroupId(result.assignment.assignments.filter(value => value.effectiveFrom <= date).at(-1)?.groupId || 'general');
      setDirty(false);
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setLoading(false); }
  }
  const selectedGroup = data?.groups.find(group => group.id === groupId);
  const available = groupId === 'general' || selectedGroup?.versions.some(version => version.effectiveFrom <= date);
  const preview = data && available ? resolveReportSchedule({ ...employee,
    scheduleAssignments: [{ effectiveFrom: date, groupId: groupId === 'general' ? null : groupId }] },
  { ...data.device, generalReportSchedule: data.generalReportSchedule, reportScheduleGroups: data.groups }, date) : null;
  async function submit(event) {
    event.preventDefault(); setSaving(true); setError(''); setSuccess('');
    try {
      const result = await apiRequest(endpoint, { method: 'PUT', body: JSON.stringify({
        effectiveFrom: date, groupId: groupId === 'general' ? null : groupId, revision: data.assignment.revision,
      }) });
      if (!mounted.current) return;
      setData(current => ({ ...current, assignment: result.assignment }));
      setDirty(false); setSuccess(`Asignacion guardada desde ${dateLabel(date)}.`);
      void onSaved();
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setSaving(false); }
  }
  function keydown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
    }
  }

  return <div className="modal-overlay report-schedules-overlay" onClick={close}>
    <section ref={dialog} className="modal-content enrollment-modal assign-schedule-modal" role="dialog" aria-modal="true" aria-labelledby="assign-schedule-title" tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={keydown}>
      <div className="enrollment-heading"><h3 id="assign-schedule-title"><Clock size={20} /> Asignar horario</h3>
        <button type="button" className="enrollment-close" title="Cerrar" aria-label="Cerrar asignacion de horario" disabled={saving} onClick={close}><X size={20} /></button>
      </div>
      <div className="enrollment-target"><strong>{device.name}</strong><span>Horarios de reportes</span></div>
      <div className="device-user-summary"><strong>{employee.name}</strong><span>ID {employee.employeeId}</span></div>
      {error && <div className="enrollment-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
      {success && <div className="enrollment-feedback is-success" role="status"><Check size={18} /><span>{success}</span></div>}
      <form onSubmit={submit}>
        <fieldset className="enrollment-fields" disabled={loading || saving}>
          <div className="field"><label htmlFor="assign-schedule-date">Vigencia desde</label><input id="assign-schedule-date" type="date" required min="0001-01-02" value={date} onChange={event => { setDate(event.target.value); setDirty(true); setSuccess(''); }} /></div>
          <div className="field"><label htmlFor="assign-schedule-group">Horario</label><select id="assign-schedule-group" value={groupId} onChange={event => { setGroupId(event.target.value); setDirty(true); setSuccess(''); }}>
            <option value="general">Horario general</option>
            {data?.groups.map(group => <option key={group.id} value={group.id} disabled={!group.versions.some(version => version.effectiveFrom <= date)}>{group.name}</option>)}
          </select></div>
          {preview && <dl className="assign-schedule-preview"><div><dt>Lunes a viernes</dt><dd>{preview.shiftStart} - {preview.shiftEnd}</dd></div><div><dt>Sabado</dt><dd>{preview.satShiftStart} - {preview.satShiftEnd}</dd></div><div><dt>Domingo</dt><dd>{preview.sundayEnabled ? `${preview.sunShiftStart} - ${preview.sunShiftEnd}` : 'Sin horario'}</dd></div><div><dt>Tolerancia de entrada</dt><dd>{preview.graceMinutes} min</dd></div></dl>}
          {data && !available && <p className="enrollment-error" role="status">Ese horario no tiene vigencia en la fecha elegida.</p>}
          {!!data?.assignment.assignments.length && <details className="schedule-history"><summary>Asignaciones guardadas ({data.assignment.assignments.length})</summary><ul>{[...data.assignment.assignments].reverse().map(value => <li className="schedule-baseline" key={value.effectiveFrom}>{dateLabel(value.effectiveFrom)}<span>{data.groups.find(group => group.id === value.groupId)?.name || 'Horario general'}</span></li>)}</ul></details>}
        </fieldset>
        <div className="enrollment-actions schedule-actions">
          {(loading || saving) && <span className="schedule-loading" role="status"><Loader2 size={17} className="spin" />{saving ? 'Guardando...' : 'Cargando...'}</span>}
          {!saving && <button type="button" className="schedule-icon-button" title="Volver a cargar asignacion" aria-label="Volver a cargar asignacion" onClick={reload} disabled={loading}><RefreshCw size={17} /></button>}
          <button type="button" className="btn-action btn-action-secondary" onClick={close} disabled={saving}>Cerrar</button>
          <button type="submit" className="btn-action btn-action-primary" disabled={loading || saving || !data || !available || !date || !dirty}><Save size={16} /> Asignar horario</button>
        </div>
      </form>
    </section>
  </div>;
}
