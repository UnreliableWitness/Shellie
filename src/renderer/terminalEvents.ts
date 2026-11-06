import { api } from './api';
import type { Events } from '../shared/ipc';

type TerminalEvent =
  | 'terminal:data'
  | 'terminal:exit'
  | 'terminal:reset'
  | 'terminal:leak';
type Handler<K extends TerminalEvent> = (payload: Events[K]) => void;

/**
 * One bridge listener per terminal event, routed by terminal id. Every running
 * task keeps its terminals mounted, so a listener per view meant each output
 * chunk crossed the context bridge once per terminal in the app.
 */
const routes = new Map<
  TerminalEvent,
  { off: () => void; byId: Map<string, Set<Handler<never>>> }
>();

export function onTerminalEvent<K extends TerminalEvent>(
  event: K,
  terminalId: string,
  handler: Handler<K>,
): () => void {
  let route = routes.get(event);
  if (!route) {
    const byId = new Map<string, Set<Handler<never>>>();
    const off = api().on(event, (p) => {
      const handlers = byId.get(p.id);
      if (!handlers) return;
      for (const h of handlers) (h as Handler<K>)(p as Events[K]);
    });
    route = { off, byId };
    routes.set(event, route);
  }
  const { byId } = route;
  let handlers = byId.get(terminalId);
  if (!handlers) byId.set(terminalId, (handlers = new Set()));
  const h = handler as Handler<never>;
  handlers.add(h);
  return () => {
    handlers.delete(h);
    if (handlers.size === 0 && byId.get(terminalId) === handlers)
      byId.delete(terminalId);
    if (byId.size === 0 && routes.get(event) === route) {
      route.off();
      routes.delete(event);
    }
  };
}
