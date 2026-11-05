import { useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export default function PwaControls() {
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [registration, setRegistration] = useState(null);
  const [error, setError] = useState('');
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, value) { if (value) setRegistration(value); },
    onRegisterError() { console.warn('No se pudo preparar la instalacion de ASISTO.'); },
  });

  useEffect(() => {
    function available(event) {
      event.preventDefault();
      if (!window.matchMedia('(display-mode: standalone)').matches) setInstallPrompt(event);
    }
    function installed() { setInstallPrompt(null); }
    window.addEventListener('beforeinstallprompt', available);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', available);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  useEffect(() => {
    if (!registration) return;
    function check() {
      if (document.visibilityState === 'visible' && navigator.onLine) void registration.update().catch(() => {});
    }
    const timer = window.setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, [registration]);

  async function install() {
    const prompt = installPrompt;
    if (!prompt) return;
    setInstallPrompt(null);
    try { await prompt.prompt(); await prompt.userChoice; }
    catch { setInstallDismissed(true); }
  }
  async function update() {
    setUpdating(true); setError('');
    try { await updateServiceWorker(true); }
    catch { setError('No se pudo actualizar.'); }
    finally { setUpdating(false); }
  }

  if (!needRefresh && (!installPrompt || installDismissed)) return null;
  return <aside className="pwa-controls" aria-label="Aplicacion ASISTO">
    {needRefresh && <div className="pwa-notice">
      <span role="status">{error || 'Nueva version disponible'}</span>
      <button type="button" className="pwa-command" onClick={update} disabled={updating}><RefreshCw size={16} className={updating ? 'spin' : ''} />Actualizar</button>
      <button type="button" className="pwa-dismiss" title="Mas tarde" aria-label="Posponer actualizacion" onClick={() => setNeedRefresh(false)} disabled={updating}><X size={16} /></button>
    </div>}
    {!needRefresh && installPrompt && !installDismissed && <div className="pwa-notice">
      <strong>ASISTO</strong>
      <button type="button" className="pwa-command" onClick={install}><Download size={16} />Instalar</button>
      <button type="button" className="pwa-dismiss" title="Ahora no" aria-label="Posponer instalacion" onClick={() => setInstallDismissed(true)}><X size={16} /></button>
    </div>}
  </aside>;
}
