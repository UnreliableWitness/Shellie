import type { BrainView } from '../../../shared/brain';

/** The organization name of an Azure DevOps URL: its last path segment, or the host when there is none. */
export function orgName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ?? u.host;
  } catch {
    return url;
  }
}

/** On a member's machine, the keeper's name: the brain-wide automatic jobs run there, not here. */
export function keeperElsewhere(brain: BrainView): string | null {
  return brain.keeper && !brain.keeper.me ? brain.keeper.name : null;
}

export const SHARED_WARNING =
  'This brain is shared. The server keeps what was already sent in its history; a real secret that got out must be changed.';
