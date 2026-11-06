import { useEffect, useState } from 'react';
import type { CostServerStatus } from '../../shared/costServer';
import { api, tryInvoke } from '../api';
import { dateTime } from '../format';
import { useStore } from '../store';
import { SettingRow, SettingsCategory } from './settings/SettingRow';

/** The cost server status from main, kept up to date by `costServer:changed`; null until it loads. */
export function useCostServerStatus(): [
  CostServerStatus | null,
  (s: CostServerStatus) => void,
] {
  const [status, setStatus] = useState<CostServerStatus | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .invoke('costServer:status')
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => undefined);
    const off = api().on('costServer:changed', (s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [status, setStatus];
}

const waitingText = (n: number) =>
  n === 0
    ? 'Nothing waiting'
    : `${n} ${n === 1 ? 'record' : 'records'} waiting`;

/** Settings: the company's cost server (address, the developer's email, the company key), its status and Disconnect. */
export function CostServerSection() {
  const notify = useStore((s) => s.notify);
  const firstEmail = useStore((s) => s.connections[0]?.userUniqueName ?? '');
  const [status, setStatus] = useCostServerStatus();
  const [url, setUrl] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  // Untouched fields follow the saved connection, else the first Azure DevOps connection's email.
  const urlValue = url ?? status?.url ?? '';
  const emailValue = email ?? status?.email ?? firstEmail;

  const connect = async () => {
    setBusy(true);
    try {
      const next = await tryInvoke(
        () =>
          api().invoke('costServer:connect', {
            url: urlValue,
            email: emailValue,
            key,
          }),
        notify,
      );
      if (!next) return;
      setStatus(next);
      if (!next.error) {
        // The key is never shown again once saved.
        setKey('');
        setUrl(null);
        setEmail(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const next = await tryInvoke(
        () => api().invoke('costServer:disconnect'),
        notify,
      );
      if (next) setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCategory id="cost-server" title="Cost server">
      <SettingRow
        id="user-cost-server"
        category="Cost server"
        title="Connection"
        description="Your company's cost server: where Shellie sends each AI request's cost, and where your budgets come from."
        keywords={[
          'Server address',
          'Email',
          'Company key',
          'connect',
          'Disconnect',
        ]}
      >
        {status ? (
          <div className="conn-form">
            <label htmlFor="cost-server-url">Server address</label>
            <input
              id="cost-server-url"
              className="field mono"
              type="url"
              placeholder="https://cost.example.com"
              value={urlValue}
              onChange={(e) => setUrl(e.target.value)}
            />
            <label htmlFor="cost-server-email">Email</label>
            <input
              id="cost-server-email"
              className="field"
              type="email"
              value={emailValue}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label htmlFor="cost-server-key">Company key</label>
            <input
              id="cost-server-key"
              className="field mono"
              type="password"
              autoComplete="off"
              placeholder={
                status.url ? 'Saved; type a new key to change it' : ''
              }
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <span />
            <span className="small muted">
              Shellie sends each AI request&apos;s model, tokens and price, and
              the task and work item it was for, to your company&apos;s cost
              server. Never prompts, code or file paths. Your budgets then come
              from the server.
            </span>
            <span />
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={connect}
                disabled={busy}
              >
                Test and connect
              </button>
              {status.url && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={disconnect}
                  disabled={busy}
                >
                  Disconnect
                </button>
              )}
            </div>
            {status.url && status.connected && (
              <div style={{ gridColumn: '1 / -1' }} className="conn-status-ok">
                {`Connected as ${status.email}`}
              </div>
            )}
            {status.url && (
              <div style={{ gridColumn: '1 / -1' }} className="small muted">
                <span>
                  {status.lastSentAt
                    ? `Last sent ${dateTime(status.lastSentAt)}`
                    : 'Nothing sent yet'}
                </span>
                {' · '}
                <span>{waitingText(status.waiting)}</span>
              </div>
            )}
            {status.error && (
              <div
                role="alert"
                className="conn-status-bad"
                style={{ gridColumn: '1 / -1' }}
              >
                {status.error}
              </div>
            )}
          </div>
        ) : (
          <div className="muted small">Loading&hellip;</div>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
