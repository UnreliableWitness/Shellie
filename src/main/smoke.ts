import os from 'node:os';
import { withTimeout } from './async';
import { pdfToMarkdown } from './brain/convert/pdf';
import { loadCanvas } from './brain/convert/raster';
import { inspectorProfiler, type Profiler } from './diagnostics/stallWatchdog';
import type { Platform } from './platform/Platform';
import { type TerminalManager, UNKNOWN_EXIT } from './services/TerminalManager';

const MARKER = 'shellie-smoke-pty';

/** src/main/brain/convert/__fixtures__/drawing.pdf: a drawn diagram on page 1, a plain page 2. */
const DRAWING_PDF =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFs0IDAgUiA2IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgMyAwIFIgPj4gPj4gL0NvbnRlbnRzIDUgMCBSID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNzAxID4+CnN0cmVhbQpCVCAvRjEgMTggVGYgNzIgNzQwIFRkIChUYXJnZXQgYXJjaGl0ZWN0dXJlKSBUaiBFVCAyIHcgNzIgNTAwIDEyMCA2MCByZSBTIEJUIC9GMSAxMiBUZiA4MiA1MjUgVGQgKFdlYiBBcHApIFRqIEVUIDI3MiA1MDAgMTIwIDYwIHJlIFMgQlQgL0YxIDEyIFRmIDI4MiA1MjUgVGQgKEFQSSBHYXRld2F5KSBUaiBFVCA0NzIgNTAwIDEyMCA2MCByZSBTIEJUIC9GMSAxMiBUZiA0ODIgNTI1IFRkIChPcmRlcnMpIFRqIEVUIDI3MiAzNTAgMTIwIDYwIHJlIFMgQlQgL0YxIDEyIFRmIDI4MiAzNzUgVGQgKEJpbGxpbmcpIFRqIEVUIDQ3MiAzNTAgMTIwIDYwIHJlIFMgQlQgL0YxIDEyIFRmIDQ4MiAzNzUgVGQgKFBvc3RncmVzKSBUaiBFVCAxOTIgNTMwIG0gMjcyIDUzMCBsIFMgMjY2IDUyNCBtIDI3MiA1MzAgbCAyNjYgNTM2IGwgUyAzOTIgNTMwIG0gNDcyIDUzMCBsIFMgNDY2IDUyNCBtIDQ3MiA1MzAgbCA0NjYgNTM2IGwgUyAzMzIgNTAwIG0gMzMyIDQxMCBsIFMgMzI2IDQwNCBtIDMzMiA0MTAgbCAzMjYgNDE2IGwgUyAzOTIgMzgwIG0gNDcyIDM4MCBsIFMgNDY2IDM3NCBtIDQ3MiAzODAgbCA0NjYgMzg2IGwgUyA1MzIgNDEwIG0gNTMyIDUwMCBsIFMgNTI2IDQ5NCBtIDUzMiA1MDAgbCA1MjYgNTA2IGwgUyBCVCAvRjEgMTAgVGYgMjAwIDU0MCBUZCAoSFRUUFMpIFRqIEVUIEJUIC9GMSAxMCBUZiA0MDAgNTQwIFRkIChSRVNUKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSAzIDAgUiA+PiA+PiAvQ29udGVudHMgNyAwIFIgPj4KZW5kb2JqCjcgMCBvYmoKPDwgL0xlbmd0aCA5MiA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcyIDcwMCBUZCAoUGxhaW4gcGFnZSB3aXRoIG9uZSBydWxlIGJlbG93IHRoZSB0aXRsZSkgVGogRVQgNzIgNjkwIG0gMzAwIDY5MCBsIFMKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTIxIDAwMDAwIG4gCjAwMDAwMDAxOTEgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAowMDAwMDAxMDY5IDAwMDAwIG4gCjAwMDAwMDExOTUgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA4IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgoxMzM3CiUlRU9GCg==';

/**
 * The packaged-app smoke check (SHELLIE_SMOKE=1): one pty through TerminalManager, running a shell command
 * that prints a marker. True when the marker arrives and the command exits 0 (or with no known exit code)
 * within the timeout.
 * Then the brain's canvas (@napi-rs/canvas, external to the bundle like node-pty) must load and encode a PNG,
 * and pdf.js must render a page through it from inside the bundle (where it cannot require the canvas itself).
 * Last, the stall watchdog's profiler must record samples: the packaged app's fuses must not take the inspector away.
 * Touches no stores, so it is safe to run from CI against a fresh install.
 */
export async function runSmoke(o: {
  terminals: TerminalManager;
  platform: Platform;
  log: (line: string) => void;
  timeoutMs?: number;
  /** The canvas package loader (default: the real one); null means it could not load. */
  canvas?: typeof loadCanvas;
  /** The profiler factory (default: the real one). */
  profiler?: () => Profiler;
}): Promise<boolean> {
  return (
    (await smokePty(o)) && (await smokeCanvas(o)) && (await smokeProfiler(o))
  );
}

async function smokeProfiler(o: {
  log: (line: string) => void;
  profiler?: () => Profiler;
}): Promise<boolean> {
  const profiler = (o.profiler ?? inspectorProfiler)();
  try {
    await profiler.start();
    await new Promise((r) => setTimeout(r, 200));
    const profile = await profiler.stop();
    if (profile.samples.length > 0) return true;
    o.log('smoke failed: profiler recorded no samples');
    return false;
  } catch (e) {
    o.log(
      `smoke failed: profiler ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    return false;
  } finally {
    profiler.dispose();
  }
}

async function smokeCanvas(o: {
  log: (line: string) => void;
  canvas?: typeof loadCanvas;
}): Promise<boolean> {
  try {
    const canvas = await (o.canvas ?? loadCanvas)();
    if (!canvas) {
      o.log('smoke failed: @napi-rs/canvas could not be loaded');
      return false;
    }
    const c = canvas.createCanvas(4, 4);
    c.getContext('2d').fillRect(0, 0, 4, 4);
    const png = await c.encode('png');
    if (png.length === 0) {
      o.log('smoke failed: the canvas encoded an empty PNG');
      return false;
    }
    const pdf = await pdfToMarkdown(Buffer.from(DRAWING_PDF, 'base64'));
    if (pdf.images.length !== 1 || pdf.warnings.length > 0) {
      o.log(
        `smoke failed: the drawing PDF gave ${pdf.images.length} picture(s); ${pdf.warnings.join('; ') || 'no warning'}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    o.log(
      `smoke failed: canvas ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    return false;
  }
}

async function smokePty(o: {
  terminals: TerminalManager;
  platform: Platform;
  log: (line: string) => void;
  timeoutMs?: number;
}): Promise<boolean> {
  const id = 'shellie-smoke';
  const { terminals, log } = o;
  try {
    const exited = new Promise<number | 'timeout'>((resolve) => {
      terminals.on('exit', (exitId, code) => {
        if (exitId === id) resolve(code);
      });
    });
    // `echo` exists in sh, zsh and PowerShell (alias of Write-Output).
    const cmd = o.platform.runCommand(`echo ${MARKER}`);
    terminals.spawn({
      id,
      taskId: 'shellie-smoke',
      cwd: os.homedir(),
      ...cmd,
    });
    const result = await withTimeout(
      exited,
      o.timeoutMs ?? 20_000,
      () => 'timeout' as const,
    );
    if (result === 'timeout') {
      log('smoke failed: the pty timed out');
      return false;
    }
    const output = terminals.buffer(id) ?? '';
    if (result === UNKNOWN_EXIT && output.includes(MARKER)) {
      // The pty closed before node-pty knew the code (conpty.dll); the marker proves the command ran.
      log('smoke: the pty reported no exit code, the marker arrived');
      return true;
    }
    if (result !== 0) {
      log(`smoke failed: exit code ${result}\n${output}`);
      return false;
    }
    if (!output.includes(MARKER)) {
      log(`smoke failed: the marker was not in the output\n${output}`);
      return false;
    }
    return true;
  } catch (e) {
    log(
      `smoke failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    return false;
  } finally {
    await terminals.kill(id);
  }
}
