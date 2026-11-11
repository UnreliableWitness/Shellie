// First, before React or a view is loaded: the link's secret leaves the address bar (and before that, before any
// schema is made, zod is told to stay within the content policy).
import './strict';
import './takeSecret';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// The reader moves the page itself: to the place in a text, and back to where the list was left.
history.scrollRestoration = 'manual';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// In a production build only: a worker in development would serve stale files.
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Without it the site works, but only with a connection.
    });
  });
