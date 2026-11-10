/// <reference types="vite/client" />
/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';
declare module '*.png?inline' {
  const src: string;
  export default src;
}

interface Window {
  shellie: import('./shared/ipc').ShellieApi;
}

// Forge's env types declare only MAIN_WINDOW_*; the splash renderer gets its own pair.
declare const SPLASH_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const SPLASH_WINDOW_VITE_NAME: string;

/** App Insights connection string baked in at build time (empty in local builds). */
declare const __APPINSIGHTS_CONNECTION_STRING__: string;

// turndown-plugin-gfm ships no types: only `gfm` (tables, strikethrough, task lists) is used.
declare module 'turndown-plugin-gfm' {
  export const gfm: (service: import('turndown')) => void;
}
