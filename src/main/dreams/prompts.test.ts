import { describe, expect, it } from 'vitest';
import { checkPrompt, DREAM_PROMPT_VERSION, proposePrompt } from './prompts';

const o = { dataDir: '/data/dreams/d1', folders: ['.apm', 'AGENTS.md'] };

describe('prompts', () => {
  const texts = {
    propose: proposePrompt({ ...o, maxProposals: 3 }),
    check: checkPrompt(o),
  };
  it('has a version', () => {
    expect(DREAM_PROMPT_VERSION).toBe(2);
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
  it('check changes no source file and writes verdicts', () => {
    expect(texts.check).toContain('change no source file');
    expect(texts.check).toContain('verdict');
    expect(texts.check).toContain('verdictWhy');
  });
});
