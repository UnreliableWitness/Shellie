import { useId, useState, type FormEvent } from 'react';
import { secretFromLink } from '../../../../src/shared/reader';

/** No secret on this phone yet: says where the link is, and takes a pasted one. */
export function Setup({
  onSecret,
}: {
  onSecret: (secret: Uint8Array<ArrayBuffer>) => void;
}) {
  const [text, setText] = useState('');
  const [refused, setRefused] = useState(false);
  const field = useId();
  const error = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const secret = secretFromLink(text);
    if (secret) onSecret(secret);
    else setRefused(true);
  };

  return (
    <div className="page">
      <header className="bar">
        <span className="brand">Shellie Reader</span>
      </header>
      <main className="setup">
        <h1>Connect this phone</h1>
        <p>
          Open the link from Shellie: <strong>Settings › User › Phone</strong>.
          Scan the code there with this phone, or copy the link and paste it
          here.
        </p>
        <form onSubmit={submit} noValidate>
          <label htmlFor={field}>The link from Shellie</label>
          <input
            id={field}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            aria-invalid={refused}
            aria-describedby={refused ? error : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setRefused(false);
            }}
          />
          {refused && (
            <p className="field-error" id={error} role="alert">
              That is not a link from Shellie. Copy it again in Settings › User
              › Phone and paste all of it.
            </p>
          )}
          <button type="submit" className="button is-primary">
            Connect
          </button>
        </form>
        <p className="quiet">
          The link is the key to your pieces. It stays on this phone and is
          never sent to the server.
        </p>
      </main>
    </div>
  );
}
