import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock, Loader2, Plus, RefreshCw, Save, Search, Sun, Users, X } from 'lucide-react';
import { dateLabel, normalizeSundaySchedule, resolveGeneralReportSchedule, resolveReportSchedule, todayInputValue } from '../utils/attendance';

function assignmentAt(employee, date) {
  return [...(employee.scheduleAssignments || [])].filter(value => value.effectiveFrom <= date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1)?.groupId || null;
}

export default function ReportSchedules({ device, getJson, apiRequest, onClose, onSaved, initialGroupId = 'general' }) {
  const [groups, setGroups] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [defaults, setDefaults] = useState(device);
  const [groupId, setGroupId] = useState(initialGroupId);
  const [effectiveFrom, setEffectiveFrom] = useState(todayInputValue);
  const [name, setName] = useState('');
  const [settings, setSettings] = useState(device);
  const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [revision, setRevision] = useState(null);
  const dialog = useRef(null);
  const mounted = useRef(true);
  const selectAll = useRef(null);
  const endpoint = `/api/device/report-schedules?deviceId=${encodeURIComponent(device.id)}`;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    mounted.current = true;
    void reload();
    dialog.current?.focus();
    return () => { mounted.current = false; document.body.style.overflow = overflow; previousFocus?.focus?.(); };
  }, []);

  function fill(id, date, list = groups, roster = employees, general = defaults) {
    const group = id === 'general' ? { name: 'Horario general', ...general.generalReportSchedule } : list.find(value => value.id === id);
    const version = [...(group?.versions || [])].filter(value => value.effectiveFrom <= date)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
    setGroupId(id); setName(group?.name || ''); setRevision(group?.revision ?? null);
    const base = resolveGeneralReportSchedule(general, date);
    const selectedVersion = version?.settings || group?.versions?.[0]?.settings;
    setSettings(id ? { ...base, ...(selectedVersion ? normalizeSundaySchedule(selectedVersion) : {}) }
      : { ...base, sundayEnabled: false, sunShiftStart: base.shiftStart, sunShiftEnd: base.shiftEnd });
    setSelected(new Set(id ? roster.filter(employee => assignmentAt(employee, date) === id).map(employee => String(employee.employeeId)) : []));
    setDirty(false); setError(''); setSuccess('');
  }
  async function reload() {
    setBusy(true); setError('');
    try {
      const data = await getJson(endpoint);
      if (!mounted.current) return;
      const general = { ...data.device, generalReportSchedule: data.generalReportSchedule };
      setGroups(data.groups); setEmployees(data.employees); setDefaults(general);
      fill(initialGroupId, effectiveFrom, data.groups, data.employees, general);
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  function confirmDiscard() { return !dirty || window.confirm('Descartar los cambios sin guardar de este horario?'); }
  function close() { if (!saving && confirmDiscard()) onClose(); }
  function changeField(field, value) { setSettings(current => ({ ...current, [field]: value })); setDirty(true); setSuccess(''); }
  function toggle(id) {
    setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setDirty(true); setSuccess('');
  }
  const context = { ...defaults, reportScheduleGroups: groups };
  const filtered = useMemo(() => employees.filter(employee =>
    `${employee.employeeId} ${employee.name}`.toLowerCase().includes(query.toLowerCase().trim()))
    .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId), 'es', { numeric: true })), [employees, query]);
  const allChecked = filtered.length > 0 && filtered.every(employee => selected.has(String(employee.employeeId)));
  const someChecked = filtered.some(employee => selected.has(String(employee.employeeId)));
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = someChecked && !allChecked; }, [someChecked, allChecked]);
  const isGeneral = groupId === 'general';
  const currentGroup = isGeneral ? defaults.generalReportSchedule : groups.find(value => value.id === groupId);
  const visibleMembers = filtered.filter(employee => !isGeneral || !assignmentAt(employee, effectiveFrom));
  const moves = employees.filter(employee => selected.has(String(employee.employeeId))
    && assignmentAt(employee, effectiveFrom) && assignmentAt(employee, effectiveFrom) !== groupId).length;
  const removed = employees.filter(employee => groupId && assignmentAt(employee, effectiveFrom) === groupId
    && !selected.has(String(employee.employeeId))).length;

  async function submit(event) {
    event.preventDefault();
    if (!isGeneral && (moves || removed) && !window.confirm(`Guardar desde ${dateLabel(effectiveFrom)}? ${moves} colaboradores cambiaran de grupo y ${removed} volveran al horario general.`)) return;
    setBusy(true); setSaving(true); setError(''); setSuccess('');
    try {
      const data = await apiRequest(groupId ? `/api/device/report-schedules/${encodeURIComponent(groupId)}?deviceId=${encodeURIComponent(device.id)}` : endpoint, {
        method: groupId ? 'PUT' : 'POST', body: JSON.stringify({ name, effectiveFrom, settings: {
          shiftStart: settings.shiftStart, shiftEnd: settings.shiftEnd,
          satShiftStart: settings.satShiftStart, satShiftEnd: settings.satShiftEnd,
          sundayEnabled: settings.sundayEnabled === true,
          sunShiftStart: settings.sunShiftStart, sunShiftEnd: settings.sunShiftEnd,
          graceMinutes: Number(settings.graceMinutes),
        }, employeeIds: [...selected], revision }),
      });
      if (!mounted.current) return;
      const general = { ...defaults, generalReportSchedule: data.generalReportSchedule };
      setDefaults(general);
      setGroups(data.groups); setEmployees(data.employees);
      fill(isGeneral ? 'general' : data.group.id, effectiveFrom, data.groups, data.employees, general);
      setSuccess(`Horario guardado desde ${dateLabel(effectiveFrom)}.`);
      void onSaved();
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) { setBusy(false); setSaving(false); } }
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
    <section ref={dialog} className="modal-content report-schedules-modal" role="dialog" aria-modal="true" aria-labelledby="report-schedules-title" tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={keydown}>
      <div className="enrollment-heading"><h3 id="report-schedules-title"><Clock size={20} /> Grupos de horario</h3>
        <button type="button" className="enrollment-close" aria-label="Cerrar horarios" title="Cerrar" onClick={close} disabled={saving}><X size={20} /></button>
      </div>
      <div className="enrollment-target"><strong>{device.name}</strong><span>Horarios de reportes</span></div>
      {error && <div className="enrollment-error" role="alert"><AlertTriangle size={17} /><span>{error}</span></div>}
      {success && <div className="enrollment-feedback is-success" role="status"><Check size={18} /><span>{success}</span></div>}
      <form onSubmit={submit}>
        <fieldset className="enrollment-fields" disabled={busy}>
          <div className="schedule-group-picker">
            <div className="field"><label htmlFor="report-schedule-group">Horario</label>
              <select id="report-schedule-group" value={groupId} onChange={event => { if (confirmDiscard()) fill(event.target.value, effectiveFrom); }}>
                <option value="general">Horario general</option>
                <option value="">Nuevo horario</option>
                {groups.map(group => <option key={group.id} value={group.id}>{group.name} ({employees.filter(employee => assignmentAt(employee, effectiveFrom) === group.id).length})</option>)}
              </select>
            </div>
            <button type="button" className="btn-action btn-action-secondary" onClick={() => { if (confirmDiscard()) fill('', effectiveFrom); }}><Plus size={16} /> Nuevo</button>
            <button type="button" className="schedule-icon-button" title="Volver a cargar horarios" aria-label="Volver a cargar horarios" onClick={() => { if (confirmDiscard()) void reload(); }}><RefreshCw size={17} /></button>
          </div>
          <div className={`schedule-editor-grid${isGeneral ? ' is-general' : ''}`}>
            <div className="schedule-definition">
              {!isGeneral && <div className="field"><label htmlFor="report-schedule-name">Nombre del horario</label><input id="report-schedule-name" required maxLength={60} value={name} onChange={event => { setName(event.target.value); setDirty(true); setSuccess(''); }} /></div>}
              <div className="field"><label htmlFor="report-schedule-date">Vigencia desde</label><input id="report-schedule-date" type="date" min="0001-01-02" required value={effectiveFrom} onChange={event => {
                const date = event.target.value;
                if (date && confirmDiscard()) { setEffectiveFrom(date); fill(groupId, date); }
              }} /></div>
              <div className="schedule-time-grid">
                {[[ 'shiftStart', 'Entrada L-V' ], [ 'shiftEnd', 'Salida L-V' ], [ 'satShiftStart', 'Entrada sabado' ], [ 'satShiftEnd', 'Salida sabado' ]].map(([field, label]) =>
                  <div className="field" key={field}><label htmlFor={`report-${field}`}>{label}</label><input id={`report-${field}`} type="time" required value={settings[field] || ''} onChange={event => changeField(field, event.target.value)} /></div>)}
              </div>
              <div className="schedule-sunday">
                <button type="button" className="schedule-sunday-toggle" role="switch" aria-label="Añadir domingo"
                  aria-checked={settings.sundayEnabled === true} aria-controls="report-sunday-fields"
                  onClick={() => changeField('sundayEnabled', !settings.sundayEnabled)}>
                  <Sun size={17} /><span>{settings.sundayEnabled ? 'Domingo activado' : 'Añadir domingo'}</span><span className="schedule-sunday-track" aria-hidden="true"><span /></span>
                </button>
                {settings.sundayEnabled && <div className="schedule-time-grid" id="report-sunday-fields">
                  {[[ 'sunShiftStart', 'Entrada domingo' ], [ 'sunShiftEnd', 'Salida domingo' ]].map(([field, label]) =>
                    <div className="field" key={field}><label htmlFor={`report-${field}`}>{label}</label><input id={`report-${field}`} type="time" required value={settings[field] || ''} onChange={event => changeField(field, event.target.value)} /></div>)}
                </div>}
              </div>
              <div className="field"><label htmlFor="report-schedule-grace">Tolerancia de entrada (min)</label><input id="report-schedule-grace" type="number" min="0" max="180" step="1" required value={settings.graceMinutes ?? 10} onChange={event => changeField('graceMinutes', event.target.value)} /></div>
              {currentGroup && <details className="schedule-history"><summary>Vigencias guardadas ({currentGroup.versions.length})</summary>
                <ul>{[...currentGroup.versions].reverse().map(version => <li key={version.effectiveFrom}>{isGeneral && version.effectiveFrom === '0001-01-01'
                  ? <span className="schedule-baseline">Horario original <span>{version.settings.shiftStart} - {version.settings.shiftEnd}</span></span>
                  : <button type="button" onClick={() => {
                  if (confirmDiscard()) { setEffectiveFrom(version.effectiveFrom); fill(groupId, version.effectiveFrom); }
                }}>{dateLabel(version.effectiveFrom)} <span>{version.settings.shiftStart} - {version.settings.shiftEnd}</span></button>}</li>)}</ul>
              </details>}
            </div>
            <div className="schedule-members">
              <div className="schedule-members-heading"><h4><Users size={16} /> Colaboradores</h4><span>{isGeneral ? employees.filter(employee => !assignmentAt(employee, effectiveFrom)).length + ' sin grupo' : selected.size + ' seleccionados'}</span></div>
              <div className="schedule-search"><Search size={16} /><input type="search" aria-label="Buscar colaboradores del horario" placeholder="Nombre o ID" value={query} onChange={event => setQuery(event.target.value)} /></div>
              {!isGeneral && <label className="schedule-select-all"><input ref={selectAll} type="checkbox" checked={allChecked} disabled={!filtered.length} onChange={() => {
                setSelected(current => { const next = new Set(current); for (const employee of filtered) {
                  if (allChecked) next.delete(String(employee.employeeId)); else next.add(String(employee.employeeId));
                } return next; }); setDirty(true); setSuccess('');
              }} /> Seleccionar resultados ({filtered.length})</label>}
              <div className="schedule-member-list" role="group" aria-label="Asignacion de colaboradores">
                {visibleMembers.map(employee => <label className={`schedule-member ${!isGeneral && selected.has(String(employee.employeeId)) ? 'is-selected' : ''}`} key={employee.employeeId}>
                  {!isGeneral && <input type="checkbox" checked={selected.has(String(employee.employeeId))} onChange={() => toggle(String(employee.employeeId))} />}
                  <span><strong>{employee.name}</strong><small>ID {employee.employeeId} · {resolveReportSchedule(employee, context, effectiveFrom).scheduleName}{employee.devicePresent === false ? ' · Historico' : ''}</small></span>
                </label>)}
                {!visibleMembers.length && <p className="empty-cell">Sin colaboradores</p>}
              </div>
              <div className="schedule-assignment-summary"><span>Sin grupo: horario general</span>{!isGeneral && moves > 0 && <span>{moves} cambiaran de grupo</span>}{!isGeneral && removed > 0 && <span>{removed} volveran al general</span>}</div>
            </div>
          </div>
        </fieldset>
        <div className="enrollment-actions schedule-actions">
          {busy && <span className="schedule-loading" role="status"><Loader2 size={17} className="spin" /> Procesando...</span>}
          <button type="button" className="btn-action btn-action-secondary" onClick={close} disabled={saving}>Cerrar</button>
          <button type="submit" className="btn-action btn-action-primary" disabled={busy || !name.trim() || !effectiveFrom || (!dirty && !!groupId)}><Save size={16} /> Guardar horario</button>
        </div>
      </form>
    </section>
  </div>;
}
