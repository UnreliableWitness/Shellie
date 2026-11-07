/**
 * What a picture is called in the UI, from the name its converter gave it (`slide-N-K`, `pN`, `pN-K`, `layout-K`,
 * `image-K`, `sheet-N-K`); a wiki mirror attachment is a 'Wiki attachment', any other name its file name.
 */
export function pictureLabel(file: string): string {
  const posix = file.replace(/\\/g, '/');
  if (posix.includes('/.attachments/')) return 'Wiki attachment';
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]*$/, '');
  let m: RegExpExecArray | null;
  if ((m = /^slide-(\d+)(?:-\d+)?$/.exec(stem))) return `Slide ${m[1]}`;
  if ((m = /^p(\d+)(?:-\d+)?$/.exec(stem))) return `Page ${m[1]}`;
  if (/^layout-\d+$/.test(stem)) return 'Slide layouts and master';
  if ((m = /^image-(\d+)$/.exec(stem))) return `Picture ${m[1]}`;
  if ((m = /^sheet-(\d+)-\d+$/.exec(stem))) return `Sheet ${m[1]}`;
  return base;
}
