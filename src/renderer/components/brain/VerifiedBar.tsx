import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';

/** A frontmatter field of a page's text, as written: quotes and a trailing comment off, a date as its day. */
export const field = (text: string, name: string): string | null => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m =
    fm && new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(fm[1]);
  if (!m) return null;
  const v = m[1]
    .replace(/\s+#.*$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  return v ? (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v) : null;
};

/** When a person last checked the page, and the button to say they just did. Only a person writes `verified`. */
export function VerifiedBar({
  text,
  brainId,
  path,
  onChanged,
}: {
  text: string;
  brainId: string;
  path: string;
  onChanged: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const verified = field(text, 'verified');
  const updated = field(text, 'last_updated');
  const confidence = field(text, 'confidence');
  const changedSince = !!verified && !!updated && updated > verified;
  const verify = () =>
    api()
      .invoke('brain:verify', brainId, path)
      .then(
        () => {
          trackBrain('verify');
          onChanged();
        },
        (e: unknown) => notify('error', errorMessage(e)),
      );
  return (
    <div className="brain-verified small" role="status">
      <span className="muted">
        {verified
          ? changedSince
            ? `Verified ${verified}, changed since (${updated})`
            : `Verified ${verified}`
          : 'Not verified by anyone yet'}
        {confidence ? ` · confidence ${confidence}` : ''}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => void verify()}
      >
        {verified ? 'Verify again' : 'Mark verified'}
      </button>
    </div>
  );
}
