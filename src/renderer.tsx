// First on purpose: ES imports run before this module's body, so the prefs copy must be an import ahead of the store.
import './renderer/migratePrefsNow';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import { createRoot } from 'react-dom/client';
import { App } from './renderer/App';
import {
  installErrorTracking,
  installLongTaskTracking,
} from './renderer/telemetry';
import { installWindowChrome } from './renderer/windowChrome';
import './renderer/styles/app.css';
import './renderer/styles/review.css';

installErrorTracking();
installLongTaskTracking();
if (window.shellie) installWindowChrome(window.shellie);
createRoot(document.getElementById('root')!).render(<App />);
