import type { Shortcut } from "./types";

type Key = Pick<
  KeyboardEvent,
  "code" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey"
>;

/** Whether a key press is this shortcut: the platform's mod key, Shift exactly as asked, no Alt. */
export function matches(e: Key, s: Shortcut, mac: boolean): boolean {
  if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey) return false;
  if (e.shiftKey !== !!s.shift) return false;
  return e.code === s.code || e.code === s.code.replace(/^Digit/, "Numpad");
}

/** The shortcut as shown to the user: "Ctrl+Shift+P". */
export function shortcutLabel(s: Shortcut, mod: "Cmd" | "Ctrl"): string {
  const key = s.code.replace(/^(Key|Digit)/, "");
  return `${mod}+${s.shift ? "Shift+" : ""}${key}`;
}
