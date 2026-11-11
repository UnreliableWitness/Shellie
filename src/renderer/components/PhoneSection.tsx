import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import type { ReaderStatus } from '../../shared/reader';
import { api, tryInvoke } from '../api';
import { plural } from '../../shared/text';
import { dateTime } from '../format';
import { useStore } from '../store';
import { SettingRow, SettingsCategory } from './settings/SettingRow';
import { ConfirmBar } from './ui/ConfirmBar';

/** The phone reader's status from main, kept up to date by `reader:changed`; null until it loads. */
export function useReaderStatus(): [
  ReaderStatus | null,
  (s: ReaderStatus) => void,
] {
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .invoke('reader:status')
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => undefined);
    const off = api().on('reader:changed', (s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [status, setStatus];
}

/** Modules of quiet zone around the code; scanners want four. */
const QUIET = 4;

/** The link as a QR code: always dark on white, whatever the theme, so a phone camera reads it. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    return { size: n + 2 * QUIET, path: d };
  }, [text]);
  return (
    <svg
      className="phone-qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

const lastPushText = (p: NonNullable<ReaderStatus['lastPush']>) =>
  p.ok
    ? `Up to date since ${dateTime(p.at)} · ${plural(p.pieces, 'piece')} on your phone`
    : `Not sent at ${dateTime(p.at)}`;

/**
 * Settings: the phone reading site. Connecting makes this install's own account on a reader server; the QR code
 * hands the phone its link, which holds the key the pieces are encrypted with.
 */
export function PhoneSection() {
  const notify = useStore((s) => s.notify);
  const [status, setStatus] = useReaderStatus();
  const [address, setAddress] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** Disconnect could not reach the server: the one case "Disconnect anyway" is offered. */
  const [unreachable, setUnreachable] = useState(false);

  const connected = status?.connected === true;
  // The link is the secret: gone from the page as soon as the connection is.
  useEffect(() => {
    if (!connected) setLink(null);
  }, [connected]);

  const run = async (
    call: () => Promise<ReaderStatus>,
  ): Promise<ReaderStatus | undefined> => {
    setBusy(true);
    try {
      const next = await tryInvoke(call, notify);
      if (next) setStatus(next);
      return next;
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const next = await run(() =>
      api().invoke('reader:connect', address, invite),
    );
    if (next && !next.error) {
      // The invitation code is never shown again once used.
      setInvite('');
      setAddress('');
      void showLink();
    }
  };

  const disconnect = async (anyway: boolean) => {
    const next = await run(() => api().invoke('reader:disconnect', anyway));
    setConfirming(false);
    setUnreachable(next?.connected === true && !!next.error);
  };

  const showLink = async () => {
    const l = await tryInvoke(() => api().invoke('reader:link'), notify);
    if (l) setLink(l);
    setCopied(false);
  };

  const copy = () => {
    if (!link) return;
    void navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <SettingsCategory id="phone" title="Phone">
      <SettingRow
        id="user-phone"
        category="Phone"
        title="Read on your phone"
        description="A brain's long reads and letters on a reading site for your phone, encrypted on this machine before they leave it."
        keywords={[
          'Server address',
          'Invitation code',
          'QR code',
          'reader',
          'smartphone',
          'Send now',
          'Disconnect',
        ]}
      >
        {!status ? (
          <div className="muted small">Loading&hellip;</div>
        ) : !connected ? (
          <div className="conn-form">
            <label htmlFor="phone-address">Server address</label>
            <input
              id="phone-address"
              className="field mono"
              type="url"
              placeholder="https://reader.example.com"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <label htmlFor="phone-invite">Invitation code</label>
            <input
              id="phone-invite"
              className="field mono"
              type="password"
              autoComplete="off"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
            <span />
            <span className="small muted">
              Shellie makes a key here, encrypts every piece with it and sends
              only the encrypted pieces. The server cannot read them. Your phone
              gets the key once, from a QR code on this screen.
            </span>
            <span />
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void connect()}
                disabled={busy || !address.trim() || !invite.trim()}
              >
                Connect
              </button>
            </div>
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
          <div className="phone-connected">
            <div className="conn-status-ok">{`Connected to ${status.url}`}</div>
            {status.refused ? (
              <div role="alert" className="conn-status-bad">
                The reader server no longer knows this connection, so nothing is
                sent. Disconnect, then connect again and scan the new code.
              </div>
            ) : (
              <div className="small muted">
                {status.lastPush
                  ? lastPushText(status.lastPush)
                  : 'Nothing sent yet'}
                {status.lastPush?.error ? `: ${status.lastPush.error}` : ''}
              </div>
            )}
            <div className="small muted">
              A brain goes to your phone once you switch on &ldquo;Send long
              reads and letters to my phone&rdquo; for it, under Project ›
              Brains.
            </div>
            {link ? (
              <div className="phone-link">
                <QrCode text={link} label="The link for your phone" />
                <div className="phone-link-text small">
                  <p>
                    Scan this with your phone&apos;s camera and open the link.
                    Then add the page to your home screen.
                  </p>
                  <p className="muted">
                    The code holds the key to your reading. Show it to nobody
                    else, and keep it out of screenshots and screen shares.
                  </p>
                  <div className="actions">
                    <button type="button" className="btn" onClick={copy}>
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setLink(null)}
                    >
                      Hide
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {confirming ? (
              <ConfirmBar
                message="Disconnect your phone?"
                details="Everything Shellie sent is removed from the server and the link on your phone stops working. What you marked as read stays in Shellie."
                confirmLabel="Disconnect"
                busy={busy}
                onConfirm={() => void disconnect(false)}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <div className="actions">
                {!link && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void showLink()}
                  >
                    Show QR code
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  onClick={() => void run(() => api().invoke('reader:send'))}
                  disabled={busy || status.refused}
                >
                  {busy ? 'Sending…' : 'Send now'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirming(true)}
                  disabled={busy}
                >
                  Disconnect
                </button>
              </div>
            )}
            {status.error && (
              <div role="alert" className="conn-status-bad">
                {status.error}
              </div>
            )}
            {unreachable && status.error && (
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void disconnect(true)}
                  disabled={busy}
                >
                  Disconnect anyway
                </button>
              </div>
            )}
          </div>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
