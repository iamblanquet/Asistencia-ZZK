export default function ExportFormat({ value, onChange, label = 'Formato de exportacion', disabled = false }) {
  return <div className="export-format" role="group" aria-label={label}>
    {['pdf', 'csv'].map(format => <button type="button" key={format} aria-pressed={value === format}
      disabled={disabled} onClick={() => onChange(format)}>{format.toUpperCase()}</button>)}
  </div>;
}
