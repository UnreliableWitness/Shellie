import type { Converted } from './types';

const OCR_THRESHOLD = 20;

export async function pdfToMarkdown(buf: Uint8Array): Promise<Converted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Once bundled there is no pdf.worker.mjs file next to the main bundle for the
  // in-process "fake worker" to load, so hand pdf.js the worker module directly.
  const g = globalThis as { pdfjsWorker?: unknown };
  g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  // Copy: pdf.js takes ownership of (detaches) the buffer it is given.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useSystemFonts: true,
  });
  try {
    const doc = await task.promise;
    const sections: string[] = [];
    let total = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        text += item.hasEOL ? '\n' : ' ';
      }
      text = text
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
      total += text.length;
      sections.push(`## p.${n}\n\n${text}`);
      page.cleanup();
    }
    return {
      markdown: sections.join('\n\n') + '\n',
      title: null,
      needsOcr: total < OCR_THRESHOLD,
      warnings: [],
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'PasswordException') {
      throw new Error('PDF is password protected', { cause: err });
    }
    throw new Error('Not a valid .pdf file', { cause: err });
  } finally {
    await task.destroy();
  }
}
