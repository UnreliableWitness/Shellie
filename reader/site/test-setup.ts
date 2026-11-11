import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The site's keys and sealing are Web Crypto; jsdom brings no `crypto.subtle`.
if (!globalThis.crypto?.subtle)
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });

// jsdom lays nothing out: scrolling is a call the tests can look at, not an error on the console.
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
Element.prototype.scrollIntoView = vi.fn();

// As in the renderer's tests: the CI runners cross the 1 s default under load.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
  history.replaceState(null, '', '/');
  document.documentElement.className = '';
});
