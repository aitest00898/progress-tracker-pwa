import { ProgressRepository } from './storage.js';
import { mountApp } from './app.js';
import { recordError } from './diagnostics.js';
import { t } from './i18n.js';
import './styles.css';

const repository = new ProgressRepository();

window.addEventListener('error', (event) => {
  if (repository.getState?.()?.settings?.developerEnabled) repository.update('uncaught_error', (state) => { recordError(state, event.error ?? new Error('Uncaught JavaScript error'), 'uncaught'); return { ok: true }; }, null, { queue: false });
});
window.addEventListener('unhandledrejection', (event) => {
  if (repository.getState?.()?.settings?.developerEnabled) repository.update('unhandled_rejection', (state) => { recordError(state, event.reason ?? new Error('Unhandled rejection'), 'unhandled_rejection'); return { ok: true }; }, null, { queue: false });
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    if (repository.getState?.()?.settings?.developerEnabled) repository.update('service_worker_error', (state) => { recordError(state, error, 'service_worker'); return { ok: true }; }, null, { queue: false });
  });
}

mountApp(repository).catch((error) => {
  const locale = repository.getState?.()?.settings?.language === 'en' ? 'en' : 'zh-TW';
  document.querySelector('#app').textContent = t(locale, 'appStartFailed');
  console.error(error);
});
