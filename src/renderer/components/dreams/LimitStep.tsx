import { useEffect, useRef, useState } from 'react';
import type { DreamLimit } from '../../../shared/dreams';
import { parseEuros, parseTokens, spacedNumber } from './folders';

type Kind = 'tokens' | 'eur';

const tokensText = (l: DreamLimit | null): string =>
  l?.kind === 'tokens' ? spacedNumber(l.perDay) : '';
const eurosText = (l: DreamLimit | null): string =>
  l?.kind === 'eur' ? String(l.perDay) : '';

/**
 * Step 2: the radios show the limit in force (`limit`). Picking a kind that needs a number only enables its field,
 * marked "not saved yet", until a valid number is committed.
 */
export function LimitStep({
  limit,
  euroLimitOffered,
  model,
  onLimit,
  onNoLimit,
}: {
  limit: DreamLimit | null;
  euroLimitOffered: boolean;
  model: string | null;
  onLimit: (l: DreamLimit) => void;
  /** "No limit" was picked: the screen asks for the second confirmation. */
  onNoLimit: () => void;
}) {
  const [tokens, setTokens] = useState(tokensText(limit));
  const [euros, setEuros] = useState(eurosText(limit));
  const [want, setWant] = useState<Kind | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // What was committed last, so that Enter followed by leaving the field saves once.
  const sent = useRef<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const limitJson = JSON.stringify(limit);
  // The fields show the limit in force: a committed, undone or externally changed limit rewrites them.
  useEffect(() => {
    setTokens(tokensText(limit));
    setEuros(eurosText(limit));
    setWant(null);
    setProblem(null);
    sent.current = null;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [limitJson]);
  useEffect(() => {
    if (want) field.current?.focus();
  }, [want]);

  const kind = limit?.kind;
  const enabled = (k: Kind) => (want ? want === k : kind === k);
  const cancel = (k: Kind | 'none') => {
    if (kind !== k) return;
    setWant(null);
    setProblem(null);
    setTokens(tokensText(limit));
    setEuros(eurosText(limit));
  };
  const unsaved = (k: Kind) => want === k && kind !== k;

  const commitTokens = () => {
    if (tokens.trim() === '') return;
    const n = parseTokens(tokens);
    if (n === null) {
      setProblem(
        'Use whole numbers, grouped by three digits if at all: 5 000 000.',
      );
      return;
    }
    setProblem(null);
    setTokens(spacedNumber(n));
    if (sent.current === `t${n}`) return;
    sent.current = `t${n}`;
    if (limit?.kind !== 'tokens' || limit.perDay !== n)
      onLimit({ kind: 'tokens', perDay: n });
  };
  const commitEuros = () => {
    if (euros.trim() === '') return;
    const n = parseEuros(euros);
    if (n === null) {
      setProblem('Use an amount above zero, such as 5 or 2.50.');
      return;
    }
    setProblem(null);
    if (sent.current === `e${n}`) return;
    sent.current = `e${n}`;
    if (limit?.kind !== 'eur' || limit.perDay !== n)
      onLimit({ kind: 'eur', perDay: n });
  };
  const enter = (commit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div role="radiogroup" aria-label="Daily limit" className="dream-limits">
      <div className="dream-limit-row">
        <label>
          <input
            type="radio"
            name="dream-limit"
            checked={kind === 'tokens'}
            onChange={() => setWant('tokens')}
            onClick={() => cancel('tokens')}
          />
          <span className="dream-limit-name">Tokens</span>
        </label>
        <input
          ref={want === 'tokens' ? field : undefined}
          className="field mono dream-number"
          aria-label="Tokens a day"
          inputMode="numeric"
          disabled={!enabled('tokens')}
          value={tokens}
          onChange={(e) => {
            sent.current = null;
            setTokens(e.target.value);
          }}
          onBlur={commitTokens}
          onKeyDown={enter(commitTokens)}
        />
        <span className="muted small">
          {unsaved('tokens')
            ? 'Not saved yet: type an amount and press Enter.'
            : 'a day · a running dream is stopped when it is reached'}
        </span>
      </div>
      <div className={`dream-limit-row${euroLimitOffered ? '' : ' dream-off'}`}>
        <label>
          <input
            type="radio"
            name="dream-limit"
            checked={kind === 'eur'}
            disabled={!euroLimitOffered}
            onChange={() => setWant('eur')}
            onClick={() => cancel('eur')}
          />
          <span className="dream-limit-name">Euros</span>
        </label>
        {euroLimitOffered ? (
          <>
            <input
              ref={want === 'eur' ? field : undefined}
              className="field mono dream-number"
              aria-label="Euros a day"
              inputMode="decimal"
              disabled={!enabled('eur')}
              value={euros}
              onChange={(e) => {
                sent.current = null;
                setEuros(e.target.value);
              }}
              onBlur={commitEuros}
              onKeyDown={enter(commitEuros)}
            />
            <span className="muted small">
              {unsaved('eur')
                ? 'Not saved yet: type an amount and press Enter.'
                : 'a day'}
            </span>
          </>
        ) : (
          <span className="muted small">
            Not available: Shellie has no price for {model ?? 'the model'}
          </span>
        )}
      </div>
      <div className="dream-limit-row">
        <label>
          <input
            type="radio"
            name="dream-limit"
            checked={kind === 'none'}
            onChange={onNoLimit}
            onClick={() => cancel('none')}
          />
          <span className="dream-limit-name">No limit</span>
        </label>
        <span className="muted small">
          For a licence without a ceiling. Shellie asks you to confirm this
          separately.
        </span>
      </div>
      {problem && (
        <p role="alert" className="small text-red">
          {problem}
        </p>
      )}
    </div>
  );
}
