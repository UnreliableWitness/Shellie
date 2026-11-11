import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { readerKeys } from '../../../src/shared/reader';
import { createApi } from './api';
import { defaultStore, type ItemStore } from './cache';
import {
  chooseBrain,
  chosenBrain,
  forgetLocal,
  loadSecret,
  prunePlaces,
  storeSecret,
  takeSecretFromAddress,
} from './local';
import { useRoute } from './route';
import { Reader } from './sync';
import { Dropdown } from './views/Dropdown';
import { ChevronDown, Dots } from './views/icons';
import { PieceView } from './views/PieceView';
import { ReadingList } from './views/ReadingList';
import { RefSheet } from './views/RefSheet';
import { Setup } from './views/Setup';

type Secret = Uint8Array<ArrayBuffer>;

/** Removes the site's own files kept by the service worker; it keeps them again at the next visit. */
async function forgetCaches() {
  try {
    for (const name of await caches.keys()) await caches.delete(name);
  } catch {
    // No cache storage here (an old browser, a test).
  }
}

/** Asks before the phone is forgotten: it cannot be undone from here. */
function ForgetDialog({
  onForget,
  onCancel,
}: {
  onForget: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="scrim">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="forget-title"
        aria-describedby="forget-text"
      >
        <h2 id="forget-title">Forget this phone?</h2>
        <p id="forget-text">
          The pieces kept on this phone and your place in each are removed. What
          you marked as read stays. To read here again, open the link from
          Shellie.
        </p>
        <div className="dialog-buttons">
          <button type="button" className="button is-danger" onClick={onForget}>
            Forget this phone
          </button>
          <button
            type="button"
            className="button is-outline"
            ref={cancel}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** The site with a secret: the reading list, a piece, a cited page over it. */
function Connected({
  secret,
  fetcher,
  store,
  onForget,
}: {
  secret: Secret;
  fetcher?: typeof fetch;
  store: ItemStore;
  onForget: () => void;
}) {
  const [reader, setReader] = useState<Reader | null>(null);
  useEffect(() => {
    let live = true;
    let made: Reader | null = null;
    void readerKeys(secret).then((keys) => {
      if (!live) return;
      made = new Reader(keys, createApi(keys, fetcher), store);
      setReader(made);
      // What is kept shows at once; the server's answer follows.
      void made.open();
      void made.sync();
    });
    return () => {
      live = false;
      made?.close();
      setReader(null);
    };
  }, [secret, fetcher, store]);

  if (!reader)
    return (
      <div className="page">
        <header className="bar">
          <span className="brand">Shellie Reader</span>
        </header>
        <main className="list">
          <p className="quiet">Opening…</p>
        </main>
      </div>
    );
  return <Shelves reader={reader} store={store} onForget={onForget} />;
}

function Shelves({
  reader,
  store,
  onForget,
}: {
  reader: Reader;
  store: ItemStore;
  onForget: () => void;
}) {
  const state = useSyncExternalStore(reader.subscribe, reader.getState);
  const { route, openPiece, openRef, closeRef, home, reset } = useRoute();
  const [brainId, setBrainId] = useState(chosenBrain);
  const [asking, setAsking] = useState(false);
  /** A check the reader asked for says that it runs; the ones the site starts itself are quiet. */
  const [asked, setAsked] = useState(false);

  // Pieces come while the phone was away: look when the page is shown again, and when the connection is back.
  useEffect(() => {
    const look = () => {
      if (document.visibilityState === 'visible') void reader.sync();
    };
    document.addEventListener('visibilitychange', look);
    window.addEventListener('online', look);
    return () => {
      document.removeEventListener('visibilitychange', look);
      window.removeEventListener('online', look);
    };
  }, [reader]);

  const shelves = state.library?.shelves;
  // A brain that is gone falls back to the first.
  const shelf =
    shelves?.find((s) => s.brainId === brainId) ?? shelves?.[0] ?? null;
  const marks = (shelf && state.library?.marks[shelf.brainId]) || NO_MARKS;

  // The places of pieces that left the shelves are of no use any more.
  useEffect(() => {
    if (!shelves || state.problem || state.syncing) return;
    const known = new Set<string>();
    for (const s of shelves)
      for (const piece of [...s.reads, ...s.letters]) known.add(piece.id);
    prunePlaces(known);
  }, [shelves, state.problem, state.syncing]);

  // The list comes back where it was left; a piece finds its own place (usePlace).
  const listScroll = useRef(0);
  const onList = route.piece === null;
  useLayoutEffect(() => {
    if (onList) window.scrollTo(0, listScroll.current);
  }, [onList]);
  const open = useCallback(
    (path: string, anchor?: string) => {
      if (onList) listScroll.current = window.scrollY;
      openPiece(path, anchor);
    },
    [openPiece, onList],
  );

  const follow = useCallback(
    (target: string, anchor?: string) => {
      const piece =
        shelf?.reads.some((r) => r.path === target) ||
        shelf?.letters.some((l) => l.path === target);
      if (piece) open(target, anchor);
      else openRef(target, anchor);
    },
    [shelf, open, openRef],
  );

  const check = useCallback(() => {
    setAsked(true);
    void reader.sync().finally(() => setAsked(false));
  }, [reader]);

  const forget = useCallback(async () => {
    reader.close();
    await store.clear().catch(() => {});
    forgetLocal();
    await forgetCaches();
    reset();
    onForget();
  }, [reader, store, reset, onForget]);

  const dialog = asking && (
    <ForgetDialog
      onForget={() => void forget()}
      onCancel={() => setAsking(false)}
    />
  );

  if (state.gone)
    return (
      <div className="page">
        <header className="bar">
          <span className="brand">Shellie Reader</span>
        </header>
        <main className="setup">
          <h1>Not connected</h1>
          <p>
            This phone is no longer connected. Open the link from Shellie again.
          </p>
          <p className="quiet">
            The link is in Shellie under Settings › User › Phone. When this is
            an icon on your home screen, forget this phone first: you can paste
            the link then.
          </p>
          <button
            type="button"
            className="button is-outline"
            onClick={() => setAsking(true)}
          >
            Forget this phone
          </button>
        </main>
        {dialog}
      </div>
    );

  if (shelf && route.piece !== null)
    return (
      <>
        <PieceView
          key={route.piece}
          reader={reader}
          shelf={shelf}
          marks={marks}
          path={route.piece}
          anchor={route.anchor}
          onOpenPiece={open}
          onOpenLink={follow}
          onBack={home}
        />
        {route.ref && (
          <RefSheet
            reader={reader}
            shelf={shelf}
            path={route.ref.path}
            anchor={route.ref.anchor}
            onOpenLink={follow}
            onClose={closeRef}
          />
        )}
      </>
    );

  return (
    <div className="page">
      <header className="bar">
        <span className="brand">Shellie Reader</span>
        <div className="bar-actions">
          {shelves && shelves.length > 1 && (
            <Dropdown
              label="Switch brain"
              items={shelves.map((s) => ({
                label: s.name,
                current: s.brainId === shelf?.brainId,
                onSelect: () => {
                  chooseBrain(s.brainId);
                  setBrainId(s.brainId);
                  window.scrollTo(0, 0);
                },
              }))}
            >
              Switch brain
              <ChevronDown />
            </Dropdown>
          )}
          <Dropdown
            label="Menu"
            className="is-end"
            items={[
              { label: 'Check for new pieces', onSelect: check },
              { label: 'Forget this phone', onSelect: () => setAsking(true) },
            ]}
          >
            <Dots />
          </Dropdown>
        </div>
      </header>

      <div className="notices" role="status">
        {asked && state.syncing && <p>Checking for new pieces…</p>}
        {state.problem === 'offline' && <p>Offline: showing what was kept</p>}
        {state.problem === 'error' && !state.syncing && (
          <p>
            The server could not be asked for new pieces.{' '}
            <button type="button" className="link" onClick={check}>
              Try again
            </button>
          </p>
        )}
      </div>

      {shelf ? (
        <ReadingList
          key={shelf.brainId}
          shelf={shelf}
          marks={marks}
          onOpen={open}
        />
      ) : (
        <main className="list">
          {state.library && !state.syncing && !state.problem ? (
            <p className="empty">
              Nothing was sent yet. In Shellie, switch on &ldquo;Send long reads
              and letters to my phone&rdquo; for a brain.
            </p>
          ) : state.library && state.problem ? (
            <p className="empty">Nothing is kept on this phone yet.</p>
          ) : (
            <p className="quiet">Opening…</p>
          )}
        </main>
      )}
      {dialog}
    </div>
  );
}

const NO_MARKS = {};

/**
 * Shellie Reader. `fetcher` and `store` are for the tests; the site itself calls its own server and keeps the
 * items in IndexedDB.
 */
export function App({
  fetcher,
  store,
}: {
  fetcher?: typeof fetch;
  store?: ItemStore;
}) {
  const [secret, setSecret] = useState<Secret | null>(loadSecret);
  const items = useMemo(() => store ?? defaultStore(), [store]);
  // The link opened again in a page that is already open: no reload, only the fragment changes.
  useEffect(() => {
    const onHash = () => {
      const taken = takeSecretFromAddress();
      if (taken) setSecret(taken);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (!secret)
    return (
      <Setup
        onSecret={(s) => {
          storeSecret(s);
          setSecret(s);
        }}
      />
    );
  return (
    <Connected
      secret={secret}
      fetcher={fetcher}
      store={items}
      onForget={() => setSecret(null)}
    />
  );
}
