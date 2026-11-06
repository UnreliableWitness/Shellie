import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ColorScheme } from '../../shared/theme';
import { claudeConfigDir } from './claudeSessions';

/**
 * Claude Code draws with its own theme (Settings `theme`: dark, light, their -daltonized and -ansi variants, custom
 * ones, or `auto`). A user's `dark` on a light Shellie terminal gives near-black prompt bars and pale text (#93), so
 * Claude Code tabs pass a theme through `--settings`. `auto` asks the terminal's background (OSC 11, which xterm
 * answers from the current theme), falls back to COLORFGBG, and asks again when the terminal reports a scheme change
 * (CSI ? 997 ; 1|2 n, see TerminalManager), so it follows Shellie live. Colour-blind and ANSI-only choices have no
 * auto variant, so they get the variant for the scheme on screen at launch, and ClaudeRetheme resumes the tab in the
 * other variant after a switch (#105); a custom theme is left alone.
 * Checked against claude 2.1.303 (2026-10-21).
 */
export function claudeThemeFor(
  userTheme: unknown,
  scheme: ColorScheme,
): string | null {
  if (typeof userTheme === 'string') {
    if (userTheme.startsWith('custom:')) return null;
    const family = /^(?:dark|light)-(daltonized|ansi)$/.exec(userTheme)?.[1];
    if (family) return `${scheme}-${family}`;
  }
  return 'auto';
}

/**
 * The scheme a theme from claudeThemeFor is fixed to: a -daltonized or -ansi variant, which Claude Code neither
 * switches by itself nor reloads from `--settings` while it runs (checked against claude 2.1.307), so the tab has to
 * start again after a scheme change (#105, ClaudeRetheme). Null for `auto` and for a theme left alone.
 */
export function fixedScheme(theme: string | null): ColorScheme | null {
  const s = theme && /^(dark|light)-/.exec(theme)?.[1];
  return s === 'dark' || s === 'light' ? s : null;
}

const readTheme = (file: string): unknown => {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { theme?: unknown })
      .theme;
  } catch {
    return undefined;
  }
};

/** The theme the user picked in Claude Code: its settings.json, else the older global config. Never throws. */
export function readClaudeTheme(env: NodeJS.ProcessEnv = process.env): unknown {
  const dir = claudeConfigDir(env);
  return (
    readTheme(path.join(dir, 'settings.json')) ??
    readTheme(
      env.CLAUDE_CONFIG_DIR
        ? path.join(dir, '.claude.json')
        : path.join(os.homedir(), '.claude.json'),
    )
  );
}

/**
 * A settings file holding only the theme, for `claude --settings <file>` (merged over the user's settings, never
 * written back). A file, not inline JSON: Windows PowerShell 5.1 drops the quotes of JSON passed to a native command.
 */
export function claudeThemeSettingsFile(dir: string, theme: string): string {
  return writeSettings(
    path.join(dir, `claude-theme-${theme}.json`),
    { theme },
    dir,
  );
}

function writeSettings(file: string, settings: object, dir: string): string {
  const content = `${JSON.stringify(settings)}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* not written yet */
  }
  if (current !== content) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    pruneDenyFiles(dir, file);
  } else {
    // Prune goes by mtime, so every use counts: a task running for weeks keeps its file.
    try {
      const t = new Date();
      utimesSync(file, t, t);
    } catch {
      /* best effort */
    }
  }
  return file;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Deny files of tasks long gone: older than a week, never the one just written. Never throws. */
function pruneDenyFiles(dir: string, keep: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^claude-settings-.+-[0-9a-f]{10}\.json$/.test(name)) continue;
      const f = path.join(dir, name);
      if (f !== keep && Date.now() - statSync(f).mtimeMs > WEEK_MS)
        unlinkSync(f);
    }
  } catch {
    /* best effort */
  }
}

/**
 * The one settings file a Claude Code tab passes with --settings: the theme (null for a custom one) and, when the
 * task has untracked secret files, `permissions.deny` rules for them (secrets feature). Without rules it is the
 * theme file as before, byte for byte; null when there is neither. The file name carries a hash of the rules, so
 * tasks with different files never share one.
 */
export function claudeSettingsFile(
  dir: string,
  opts: { theme?: string | null; deny?: string[] },
): string | null {
  const deny = opts.deny ?? [];
  if (deny.length === 0)
    return opts.theme ? claudeThemeSettingsFile(dir, opts.theme) : null;
  const hash = createHash('sha256')
    .update(JSON.stringify(deny))
    .digest('hex')
    .slice(0, 10);
  return writeSettings(
    path.join(dir, `claude-settings-${opts.theme ?? 'custom'}-${hash}.json`),
    { ...(opts.theme ? { theme: opts.theme } : {}), permissions: { deny } },
    dir,
  );
}

/** COLORFGBG ("foreground;background" as ANSI colour numbers) for programs that read it, Claude Code's `auto` too. */
export const colorFgBg = (scheme: ColorScheme): string =>
  scheme === 'light' ? '0;15' : '15;0';
