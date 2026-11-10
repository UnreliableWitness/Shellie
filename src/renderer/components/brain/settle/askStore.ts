import { local } from '../../../localStorage';

/** Who a parked conflict was asked: a name, so it stays on this machine (never committed, never in a prompt). */
const KEY = (brainId: string) => `shellie.brain.ask.${brainId}`;

const read = (brainId: string): Record<string, string> => {
  try {
    const v: unknown = JSON.parse(local()?.getItem(KEY(brainId)) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
};

const write = (brainId: string, all: Record<string, string>) => {
  try {
    local()?.setItem(KEY(brainId), JSON.stringify(all));
  } catch {
    // Only a convenience: the list then says "Asked someone".
  }
};

export const askedWho = (brainId: string, id: string): string =>
  read(brainId)[id] ?? '';

export function setAskedWho(brainId: string, id: string, who: string) {
  write(brainId, { ...read(brainId), [id]: who });
}

export function forgetAsked(brainId: string, id: string) {
  const { [id]: _gone, ...rest } = read(brainId);
  write(brainId, rest);
}
