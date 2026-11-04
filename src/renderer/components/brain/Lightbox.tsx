import { useEffect } from 'react';

/** A picture at full size over the page; Esc or a click closes it (the app opens no new windows). */
export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="brain-lightbox"
      role="dialog"
      aria-label={alt || 'Picture'}
      onClick={onClose}
    >
      <img src={src} alt={alt} />
    </div>
  );
}
