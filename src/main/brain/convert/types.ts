export type Converted = {
  markdown: string;
  title: string | null;
  needsOcr: boolean;
  warnings: string[];
};

/** First `# ` heading of a markdown text, or null. */
export function firstHeading(markdown: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return m ? m[1].trim() : null;
}
