/** The window's localStorage, or undefined where there is none (tests, a worker). */
export const local = (): Storage | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage;
