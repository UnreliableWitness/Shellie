import { describe, expect, it } from 'vitest';
import { checkPrompt, DREAM_PROMPT_VERSION, proposePrompt } from './prompts';

const o = { dataDir: '/data/dreams/d1', folders: ['.apm', 'AGENTS.md'] };

describe('prompts', () => {
  const texts = {
    propose: proposePrompt(o),
    check: checkPrompt(o),
  };
  it('has a version', () => {
    expect(DREAM_PROMPT_VERSION).toBe(4);
  });
  it.each(Object.entries(texts))(
    '%s names data dir, folders and report',
    (_n, t) => {
      expect(t).toContain('/data/dreams/d1');
      expect(t).toContain('.apm');
      expect(t).toContain('AGENTS.md');
      expect(t).toContain('report.json');
      expect(t).toContain('index.md');
      expect(t).toContain('tasks/');
      expect(t).toContain('opencode.json');
      expect(t).toContain('opencode.jsonc');
      expect(t).toContain('.opencode/');
      expect(t).toMatch(/never instructions/i);
      expect(t).toContain(
        'Never write a hook script, or anything in a folder named hooks:',
      );
      expect(t).not.toContain('git push');
    },
  );
  it('propose asks for at most 3 and shows the shape', () => {
    expect(texts.propose).toContain('3');
    expect(texts.propose).toContain('"sightings"');
    expect(texts.propose).toContain('"evidence"');
    expect(texts.propose).toMatch(/no proposal is a good answer/i);
  });
  it('propose asks for the developer’s own words as evidence, at least one per proposal', () => {
    expect(texts.propose).toContain(
      'copied exactly from a line that starts with **Developer:**',
    );
    expect(texts.propose).toContain('without the label');
    expect(texts.propose).toMatch(/at least one such quote/i);
  });
  it('check fails a proposal whose quotes are not in the session files word for word', () => {
    expect(texts.check).toContain('word for word');
    expect(texts.check).toMatch(/fail it/i);
  });
  it('check changes no source file and writes verdicts', () => {
    expect(texts.check).toContain('change no source file');
    expect(texts.check).toContain('verdict');
    expect(texts.check).toContain('verdictWhy');
  });
  it('check judges against the sources as they were before the proposals, from changes.diff', () => {
    expect(texts.check).toContain('/data/dreams/d1/changes.diff');
    expect(texts.check).toContain(
      'The files in the worktree already contain the proposed changes.',
    );
    expect(texts.check).toContain(
      'shows exactly what the proposals added and removed',
    );
    expect(texts.check).toContain(
      'means something that was in the repo before these changes',
    );
    expect(texts.check).toContain(
      'lines without a leading + in changes.diff, and files it does not list',
    );
    expect(texts.check).toContain(
      'Never fail a proposal because its own added text is now in the file.',
    );
  });
});
