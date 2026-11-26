import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .then((registration) => registration.update())
      .catch((error) => console.warn('Não foi possível atualizar o aplicativo:', error));
  });
}
