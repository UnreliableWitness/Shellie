import { describe, expect, it } from 'vitest';
import {
  branchType,
  claudeContext,
  renderBranch,
  renderTaskMd,
  slugify,
  taskSlug,
} from './naming';
import type { Task, WorkItemDetails } from './types';

const story = {
  id: '48231',
  type: 'User Story' as const,
  title: 'Show estimated delivery date on product page',
  url: null,
};
const bug = {
  id: '48227',
  type: 'Bug' as const,
  title: 'Coupon code field ignores trailing spaces',
  url: null,
};

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Show estimated delivery date')).toBe(
      'show-estimated-delivery-date',
    );
  });
  it('strips accents, emoji and punctuation', () => {
    expect(slugify('Café résumé 🚀 (v2)!')).toBe('cafe-resume-v2');
  });
  it('caps at 40 characters without a trailing dash', () => {
    const s = slugify(
      'This is a very long work item title that keeps going and going forever',
    );
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
    expect(s).toBe('this-is-a-very-long-work-item-title-that');
  });
  it('returns "task" for an empty result', () => {
    expect(slugify('!!!')).toBe('task');
  });
});

describe('branchType', () => {
  it('is bugfix for bugs and feature otherwise', () => {
    expect(branchType(bug)).toBe('bugfix');
    expect(branchType(story)).toBe('feature');
    expect(branchType({ ...story, type: 'Task' })).toBe('feature');
    expect(branchType(null)).toBe('feature');
  });
  it('treats Basic-process types as features', () => {
    expect(branchType({ id: '1', type: 'Issue', title: 't', url: null })).toBe(
      'feature',
    );
    expect(branchType({ id: '1', type: 'Epic', title: 't', url: null })).toBe(
      'feature',
    );
  });
});

describe('renderBranch', () => {
  const tpl = '{type}/{id}-{slug}';
  it('renders a work item', () => {
    expect(renderBranch(tpl, { workItem: story, name: '' })).toBe(
      'feature/48231-show-estimated-delivery-date-on-product',
    );
    expect(renderBranch(tpl, { workItem: bug, name: '' })).toBe(
      'bugfix/48227-coupon-code-field-ignores-trailing-space',
    );
  });
  it('drops the id segment for a blank task', () => {
    expect(
      renderBranch(tpl, { workItem: null, name: 'spike new search' }),
    ).toBe('feature/spike-new-search');
  });
  it('supports templates without a type', () => {
    expect(
      renderBranch('users/dries/{id}-{slug}', { workItem: story, name: '' }),
    ).toBe('users/dries/48231-show-estimated-delivery-date-on-product');
  });
});

describe('taskSlug', () => {
  it('prefixes the id when there is a work item', () => {
    expect(taskSlug(story, '')).toBe(
      '48231-show-estimated-delivery-date-on-product',
    );
    expect(taskSlug(null, 'Spike: new search')).toBe('spike-new-search');
  });
});

const task: Task = {
  id: 't1',
  repoId: 'r1',
  name: '',
  workItem: story,
  slug: '48231-show-estimated-delivery-date-on',
  branch: 'feature/48231-show-estimated-delivery-date-on',
  worktreePath: '/src/webshop.worktrees/48231-show-estimated-delivery-date-on',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'ready',
  setup: {
    copy: true,
    commands: ['npm ci'],
    startClaude: true,
    openShell: true,
    openCopilot: false,
  },
  terminals: [],
  createdAt: '2026-10-14T09:00:00.000Z',
  finishedAt: null,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
};

describe('renderTaskMd', () => {
  it('lists the work item, branch and worktree', () => {
    const md = renderTaskMd(task);
    expect(md).toContain(
      '# User Story 48231: Show estimated delivery date on product page',
    );
    expect(md).toContain(
      '- Branch: `feature/48231-show-estimated-delivery-date-on`',
    );
    expect(md).toContain(
      '- Worktree: `/src/webshop.worktrees/48231-show-estimated-delivery-date-on`',
    );
  });
  it('uses the task name for blank tasks', () => {
    expect(
      renderTaskMd({ ...task, workItem: null, name: 'Spike new search' }),
    ).toContain('# Task: Spike new search');
  });

  const details = (over: Partial<WorkItemDetails> = {}): WorkItemDetails => ({
    fields: {
      'System.Title': 'Show estimated delivery date on product page',
      'System.WorkItemType': 'User Story',
      'System.State': 'Active',
      'System.AssignedTo': { displayName: 'Ann Smith', uniqueName: 'a@b.c' },
      'System.AreaPath': 'Shop',
      'System.IterationPath': 'Shop\\Sprint 4',
      'System.Tags': 'checkout; ux',
      'System.Description':
        '<div>Show the <b>date</b> &amp; time.</div><ul><li>One</li><li>Two</li></ul>',
      'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>Date is shown</p>',
      'Custom.Customer': 'Contoso',
      'System.CreatedBy': { displayName: 'Bob Jones' },
      'System.Watermark': 99,
      'System.Rev': 7,
      'System.AuthorizedAs': { displayName: 'Ann Smith' },
      'Custom.Empty': '',
    },
    url: 'https://dev.azure.com/o/p/_workitems/edit/48231',
    links: [{ name: 'Parent', id: '48000' }],
    comments: [
      {
        author: 'Bob Jones',
        createdDate: '2026-10-01T10:00:00Z',
        text: '<p>First &lt;comment&gt;</p>',
        html: true,
      },
      {
        author: 'Ann Smith',
        createdDate: '2026-10-02T10:00:00Z',
        text: 'Second, in **markdown**',
        html: false,
      },
    ],
    ...over,
  });

  it('renders exactly as before without details', () => {
    expect(renderTaskMd(task, {}, undefined)).toBe(renderTaskMd(task));
    expect(renderTaskMd(task)).not.toContain('## Work item');
  });

  it('adds the work item fields, description and comments in order', () => {
    const md = renderTaskMd(task, {}, details());
    const order = [
      renderTaskMd(task).trimEnd(),
      '## Work item',
      '- Title: Show estimated delivery date on product page',
      '- Type: User Story',
      '- State: Active',
      '- Assigned to: Ann Smith',
      '- Area: Shop',
      '- Iteration: Shop\\Sprint 4',
      '- Tags: checkout; ux',
      '- URL: https://dev.azure.com/o/p/_workitems/edit/48231',
      '- Parent: 48000',
      '### Description',
      'Show the date & time.\n\n- One\n- Two',
      '### Acceptance criteria',
      'Date is shown',
      '### Other fields',
      '- Custom.Customer: Contoso',
      '- System.CreatedBy: Bob Jones',
      '## Comments',
      '### Bob Jones, 2026-10-01T10:00:00Z',
      'First <comment>',
      '### Ann Smith, 2026-10-02T10:00:00Z',
      'Second, in **markdown**',
    ];
    let at = 0;
    for (const part of order) {
      const i = md.indexOf(part, at);
      expect(i, part).toBeGreaterThanOrEqual(at);
      at = i + part.length;
    }
    expect(md).not.toMatch(/<\/?(div|b|p|ul|li)>/);
    expect(md).toContain('- System.CreatedBy: Bob Jones\n\n## Comments');
    expect(md).not.toContain('Watermark');
    expect(md).not.toContain('System.Rev');
    expect(md).not.toContain('AuthorizedAs');
    expect(md).not.toContain('Custom.Empty');
  });

  it('uses repro steps when there are no acceptance criteria', () => {
    const d = details();
    delete d.fields['Microsoft.VSTS.Common.AcceptanceCriteria'];
    d.fields['Microsoft.VSTS.TCM.ReproSteps'] = '<p>Click buy</p>';
    const md = renderTaskMd(task, {}, d);
    expect(md).toContain('### Repro steps\n\nClick buy');
    expect(md).not.toContain('Microsoft.VSTS.TCM.ReproSteps');
  });

  it('keeps the newest comments when the work item is too big', () => {
    const comments = Array.from({ length: 300 }, (_, i) => ({
      author: 'Ann',
      createdDate: `c${i}`,
      text: 'x'.repeat(1000),
      html: false,
    }));
    const md = renderTaskMd(task, {}, details({ comments }));
    expect(md.length).toBeLessThan(210_000);
    expect(md).toContain('### Ann, c299');
    expect(md).not.toContain('### Ann, c0\n');
    expect(md).toMatch(/\d+ older comments left out/);
  });
});

describe('other repos', () => {
  const extra = {
    id: 'w2',
    repoId: 'api',
    branch: task.branch,
    worktreePath: '/src/api.worktrees/x',
    baseRef: 'origin/main',
    baseSha: null,
    source: 'detected' as const,
    summary: null,
    pullRequest: null,
    reopen: null,
    dropped: false,
  };
  it('tells Claude how to make a worktree elsewhere', () => {
    const t = { ...task, slug: '42-x', branch: 'feature/42-x' };
    expect(
      claudeContext(t).startsWith('This folder is a Shellie task for '),
    ).toBe(true);
    expect(claudeContext(t)).toContain(
      'worktree add <repo>.worktrees/42-x -b feature/42-x <base>',
    );
  });
  it('lists every workspace in task.md', () => {
    const md = renderTaskMd(
      { ...task, extraWorkspaces: [extra] },
      {
        api: '/src/api',
      },
    );
    expect(md).toContain('`/src/api`');
    expect(md).toContain('## Workspaces');
    expect(md).toContain('/src/api.worktrees/x');
    expect(md).toContain('worktree add <repo>.worktrees/');
    expect(renderTaskMd(task)).not.toContain('## Workspaces');
  });
});

describe('claudeContext', () => {
  it('names the work item, points at the task file and says to wait for the user', () => {
    expect(claudeContext(task)).toContain(
      "This folder is a Shellie task for User Story 48231: Show estimated delivery date on product page. The details are in .shellie/task.md. Do not start on the task by yourself: wait for the user's instructions.",
    );
    expect(claudeContext({ ...task, workItem: null, name: 'Spike' })).toContain(
      'Shellie task for Task: Spike.',
    );
  });
});

describe('claudeContext and shellie run', () => {
  const t = {
    workItem: null,
    name: 'Spike',
    branch: 'feature/spike',
    slug: 'spike',
  };
  it('names the commands that run with secrets when the repo has some', () => {
    expect(claudeContext(t, ['dev', 'test', 'setup'])).toContain(
      "Commands that need this project's secrets (tests, the dev server) run through `shellie run <name>`; available: dev, test, setup. Plain commands in your shell run without secrets.",
    );
  });
  it('stays as it was without stored secrets', () => {
    expect(claudeContext(t, undefined)).toBe(claudeContext(t));
    expect(claudeContext(t, [])).toBe(claudeContext(t));
    expect(claudeContext(t)).not.toContain('shellie run');
  });
});
