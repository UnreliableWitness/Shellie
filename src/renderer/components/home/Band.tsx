import type { ReactNode } from 'react';

/** A titled band; `aside` (meta text, commands) sits at the right end of the title row. */
export function Band({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const heading = <h2 className="home-band-title">{title}</h2>;
  return (
    <section aria-label={title} className="home-band">
      {aside ? (
        <div className="home-band-head">
          {heading}
          {aside}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}
