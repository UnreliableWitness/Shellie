import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useStore } from '../../store';
import { Lightbox } from './Lightbox';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/**
 * What a brain page does with its files: loads a picture of the brain, opens a picture in the lightbox or a
 * source in its app, and opens a picture clicked in the body. Render `lightbox` once, inside the page.
 */
export function usePageMedia(brainId: string): {
  asset: (p: string) => Promise<string>;
  openFile: (p: string) => void;
  /** Opens a picture already loaded (a data URL) in the lightbox. */
  view: (src: string, alt: string) => void;
  onBodyClick: (e: MouseEvent<HTMLElement>) => void;
  lightbox: ReactNode;
} {
  const notify = useStore((s) => s.notify);
  const [picture, setPicture] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const asset = useCallback(
    (p: string) => api().invoke('brain:asset', brainId, p),
    [brainId],
  );
  const view = useCallback(
    (src: string, alt: string) => setPicture({ src, alt }),
    [],
  );
  const openFile = (p: string) => {
    if (IMAGE.test(p)) {
      asset(p).then(
        (src) => view(src, p.split('/').pop() ?? p),
        (e: unknown) => notify('error', errorMessage(e)),
      );
    } else if (p.startsWith('sources/')) {
      api()
        .invoke('brain:openSource', brainId, p)
        .catch((e: unknown) => notify('error', errorMessage(e)));
    } else notify('error', `${p} is not a page, a picture or a source file`);
  };
  // A picture in the body opens at full size.
  const onBodyClick = (e: MouseEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    // A picture that is itself a link follows the link, not the lightbox.
    if (t.tagName === 'IMG' && !t.closest('a')) {
      const img = t as HTMLImageElement;
      if (img.src) view(img.src, img.alt);
    }
  };
  const lightbox = picture && (
    <Lightbox
      src={picture.src}
      alt={picture.alt}
      onClose={() => setPicture(null)}
    />
  );
  return { asset, openFile, view, onBodyClick, lightbox };
}
