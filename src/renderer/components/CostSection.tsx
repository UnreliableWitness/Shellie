import { useEffect, useState } from 'react';
import type { Rate, ReceiverStatus } from '../../shared/usage';
import { defaultSettings, OFFICIAL_USD_TO_EUR } from '../../shared/usage';
import { api, saveSettings, tryInvoke } from '../api';
import { useStore } from '../store';
import { SettingRow, SettingsCategory } from './settings/SettingRow';

type SettingsDraft = {
  receiverPort: string;
};

/** A number typed in a field, or null when it is blank or not a number (Number('') would be 0). */
const parseNumber = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A price with up to 3 decimals and no trailing zeros. */
const price = (n: number): string => String(Math.round(n * 1000) / 1000);

const tier = (r: Rate): string =>
  [
    r.minInputTokens > 0 ? `from ${r.minInputTokens} input tokens` : '',
    r.fast ? 'fast' : '',
  ]
    .filter(Boolean)
    .join(', ');

function InvoicingPart() {
  const notify = useStore((s) => s.notify);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [status, setStatus] = useState<ReceiverStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('settings:get'), notify).then((s) => {
      if (live && s) {
        setDraft({
          receiverPort: String(s.receiverPort),
        });
        setSavedPort(s.receiverPort);
      }
    });
    const load = () =>
      api()
        .invoke('usage:receiverStatus')
        .then((r) => {
          if (live) setStatus(r);
        })
        .catch(() => undefined);
    void load();
    const off = api().on('usage:receiverStatus', (r) => setStatus(r));
    return () => {
      live = false;
      off();
    };
  }, [notify]);

  const savePort = async (receiverPort: number) => {
    const saved = await tryInvoke(
      () =>
        saveSettings({
          receiverPort,
        }),
      notify,
    );
    if (saved) {
      setSavedPort(saved.receiverPort);
      notify('info', 'Settings saved');
    }
  };

  const save = async () => {
    if (!draft) return;
    const receiverPort = parseNumber(draft.receiverPort);
    if (receiverPort === null) {
      setError('Usage receiver port must be a number');
      return;
    }
    setError(null);
    await savePort(receiverPort);
  };

  const reset = async () => {
    const port = defaultSettings().receiverPort;
    setDraft({ receiverPort: String(port) });
    setError(null);
    await savePort(port);
  };

  return (
    <SettingRow
      id="user-cost-port"
      category="AI cost"
      title="Usage receiver port"
      description="The local port Claude Code sends its usage to (OpenTelemetry). Amounts are in EUR."
      keywords={['OpenTelemetry', 'OTLP', 'receiver', 'currency', 'invoice']}
      modified={
        savedPort !== null && savedPort !== defaultSettings().receiverPort
      }
      onReset={() => void reset()}
    >
      {draft && (
        <div className="conn-form">
          <span>Invoice currency</span>
          <span>{`EUR at ${OFFICIAL_USD_TO_EUR} per USD (built in)`}</span>
          <label htmlFor="cost-port">Usage receiver port</label>
          <input
            id="cost-port"
            className="field mono"
            type="number"
            value={draft.receiverPort}
            onChange={(e) =>
              setDraft({ ...draft, receiverPort: e.target.value })
            }
          />
          <span />
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={save}>
              Save settings
            </button>
          </div>
          {error && (
            <div
              role="alert"
              className="conn-status-bad"
              style={{ gridColumn: '1 / -1' }}
            >
              {error}
            </div>
          )}
        </div>
      )}
      {status && (
        <div className="conn-form">
          <div
            style={{ gridColumn: '1 / -1' }}
            className={status.listening ? 'conn-status-ok' : 'conn-status-bad'}
          >
            {status.listening
              ? `Listening on 127.0.0.1:${status.port}`
              : (status.error ?? 'Usage receiver is not running')}
          </div>
          <div style={{ gridColumn: '1 / -1' }} className="small muted">
            {`Copilot CLI: ${status.copilot.records} records captured, ${status.copilot.unreadable} unreadable (unverified: built from documentation)`}
          </div>
        </div>
      )}
    </SettingRow>
  );
}

function RatesPart() {
  const notify = useStore((s) => s.notify);
  const [rows, setRows] = useState<Rate[]>([]);
  const [officialAsOf, setOfficialAsOf] = useState('');

  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('rates:list'), notify).then((r) => {
      if (live && r) {
        setRows(r.rates);
        setOfficialAsOf(r.officialAsOf);
      }
    });
    return () => {
      live = false;
    };
  }, [notify]);

  return (
    <SettingRow
      id="user-cost-rates"
      category="AI cost"
      title="Rates"
      description="The built-in official list prices every amount is priced with, read-only."
      keywords={['prices', 'models', 'tokens', 'USD', 'rate table']}
    >
      {officialAsOf ? (
        <RatesTable rows={rows} officialAsOf={officialAsOf} />
      ) : (
        <div className="muted small">Loading&hellip;</div>
      )}
    </SettingRow>
  );
}

function RatesTable({
  rows,
  officialAsOf,
}: {
  rows: Rate[];
  officialAsOf: string;
}) {
  return (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>
        {`Official list prices as of ${officialAsOf} (USD per 1M tokens)`}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="rates">
          <thead>
            <tr>
              <th>Model</th>
              <th>Matches</th>
              <th>Tier</th>
              <th>Input</th>
              <th>Cached input</th>
              <th>Cache write</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td className="mono">{r.match.join(', ')}</td>
                <td>{tier(r)}</td>
                <td className="mono">{price(r.inputPerM)}</td>
                <td className="mono">{price(r.cachedInputPerM)}</td>
                <td className="mono">{price(r.cacheWritePerM)}</td>
                <td className="mono">{price(r.outputPerM)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function CostSection() {
  return (
    <SettingsCategory id="cost" title="AI cost and invoicing">
      <InvoicingPart />
      <RatesPart />
    </SettingsCategory>
  );
}
