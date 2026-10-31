// The GitHub Project board "Shellie" (Projects v2 on the owner's account): one sync makes it show where every
// issue is, and reads the owner's steering from it (draft cards become issues, a card dragged to Ready is a
// go-ahead, the order of Ready is the implementer's priority). The plan is in project-sync.mjs; this file talks
// to GitHub. A GitHub App cannot change a personal account's projects, so this uses the owner's classic token
// (scopes project and public_repo), handed over in a file and used only here, never where an agent runs.
import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseConfig } from './config.mjs';
import { createGitHub, readTokenFile } from './github.mjs';
import { COLUMNS } from './project-columns.mjs';
import { planSync, readyRank } from './project-sync.mjs';

const OWNER = 'UnreliableWitness';
const REPO = 'Shellie';
const TITLE = 'Shellie';
const COLORS = {
  Inbox: 'GRAY',
  'Needs info': 'YELLOW',
  'Needs you': 'ORANGE',
  Ready: 'BLUE',
  'In progress': 'PURPLE',
  'In review': 'PURPLE',
  'Waiting for you': 'ORANGE',
  Merged: 'GREEN',
  Released: 'GREEN',
  Closed: 'GRAY',
};

/** GraphQL through gh, with the project token in gh's own environment only. */
export function createGraphQL(token) {
  const env = { ...process.env, GH_TOKEN: token };
  return (query, variables = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'gh',
        ['api', 'graphql', '--input', '-'],
        { env, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err)
            return reject(new Error(`graphql: ${stderr || err.message}`));
          const r = JSON.parse(stdout);
          if (r.errors?.length)
            return reject(
              new Error(
                `graphql: ${r.errors.map((e) => e.message).join('; ')}`,
              ),
            );
          resolve(r.data);
        },
      );
      child.stdin.end(JSON.stringify({ query, variables }));
    });
}

const STATUS_FIELD = `fields(first: 30) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }`;

/**
 * Finds the board (creating it, linked to the repo, the first time) and makes its Status field hold exactly
 * the agent columns.
 * @returns {Promise<{ projectId: string, url: string, fieldId: string, optionIds: Map<string, string>, repositoryId: string }>}
 */
export async function ensureBoard(ql) {
  const d = await ql(
    `query($login: String!, $repo: String!) {
      user(login: $login) { id projectsV2(first: 50) { nodes { id title url ${STATUS_FIELD} } } }
      repository(owner: $login, name: $repo) { id }
    }`,
    { login: OWNER, repo: REPO },
  );
  const repositoryId = d.repository.id;
  let project = d.user.projectsV2.nodes.find((p) => p.title === TITLE);
  if (!project) {
    const c = await ql(
      `mutation($owner: ID!, $title: String!) { createProjectV2(input: { ownerId: $owner, title: $title }) {
        projectV2 { id url ${STATUS_FIELD} } } }`,
      { owner: d.user.id, title: TITLE },
    );
    project = c.createProjectV2.projectV2;
    await ql(
      `mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: { projectId: $p, repositoryId: $r }) { clientMutationId } }`,
      { p: project.id, r: repositoryId },
    );
  }
  let field = project.fields.nodes.find((f) => f?.name === 'Status');
  // every new project has a Status field; one deleted by hand is not recreated here
  if (!field) throw new Error(`the "${TITLE}" project has no Status field`);
  const names = (field?.options ?? []).map((o) => o.name);
  if (names.join('|') !== COLUMNS.join('|')) {
    const u = await ql(
      `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
        updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) {
          projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } } } }`,
      {
        f: field.id,
        o: COLUMNS.map((name) => ({
          name,
          color: COLORS[name],
          description: '',
        })),
      },
    );
    field = u.updateProjectV2Field.projectV2Field;
  }
  return {
    projectId: project.id,
    url: project.url,
    fieldId: field.id,
    optionIds: new Map(field.options.map((o) => [o.name, o.id])),
    repositoryId,
  };
}

/** Every card on the board, in the board's order. */
export async function loadBoard(ql, projectId) {
  const cards = [];
  let after = null;
  for (;;) {
    const d = await ql(
      `query($p: ID!, $after: String) { node(id: $p) { ... on ProjectV2 { items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content { __typename
            ... on Issue { number state labels(first: 30) { nodes { name } } repository { nameWithOwner } }
            ... on DraftIssue { title } } } } } } }`,
      { p: projectId, after },
    );
    const items = d.node.items;
    for (const n of items.nodes)
      cards.push({
        itemId: n.id,
        column: n.fieldValueByName?.name ?? null,
        content:
          n.content?.__typename === 'Issue'
            ? {
                type: 'Issue',
                number: n.content.number,
                state: n.content.state,
                labels: n.content.labels.nodes.map((l) => l.name),
                repo: n.content.repository.nameWithOwner,
              }
            : n.content?.__typename === 'DraftIssue'
              ? { type: 'DraftIssue', title: n.content.title }
              : null,
      });
    if (!items.pageInfo.hasNextPage) return cards;
    after = items.pageInfo.endCursor;
  }
}

/** The Ready cards' order, for the implementer's pick (empty without a token or a board). */
export async function boardRank(token) {
  if (!token) return new Map();
  const ql = createGraphQL(token);
  const board = await ensureBoard(ql);
  return readyRank(await loadBoard(ql, board.projectId));
}

/**
 * One sync: the plan from project-sync.mjs, carried out. Each step on its own: one that fails is reported and
 * the rest go on.
 * @param {{ ql: any, gh: any, config: any, summary: (l: string) => void }} o gh: the REST client with the same token
 */
export async function runSync({ ql, gh, config, summary }) {
  const board = await ensureBoard(ql);
  const cards = await loadBoard(ql, board.projectId);
  const issues = (await gh.listOpenIssues()).map((i) => ({
    id: i.node_id,
    number: i.number,
    state: 'OPEN',
    labels: i.labels.map((l) => l.name),
  }));
  const skip = new Set(
    issues
      .filter((i) => i.labels.includes('agent:activity'))
      .map((i) => i.number),
  );
  const waitsForOwner = new Set(
    (await gh.listOpenPulls())
      .filter(
        (p) =>
          p.user?.login === config.botLogin &&
          p.labels?.some(
            (l) =>
              l.name === 'agent:awaits-owner' || l.name === 'agent:hold-merge',
          ),
      )
      .map((p) =>
        Number([...(p.body ?? '').matchAll(/Fixes #(\d+)/g)].at(-1)?.[1]),
      )
      .filter(Number.isInteger),
  );
  const setColumn = (itemId, column) =>
    ql(
      `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: {
        projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { clientMutationId } }`,
      {
        p: board.projectId,
        i: itemId,
        f: board.fieldId,
        o: board.optionIds.get(column),
      },
    );

  for (const step of planSync({ board: cards, issues, waitsForOwner, skip })) {
    try {
      if (step.type === 'convert') {
        await ql(
          `mutation($i: ID!, $r: ID!) { convertProjectV2DraftIssueItemToIssue(input: { itemId: $i, repositoryId: $r }) {
            item { id } } }`,
          { i: step.itemId, r: board.repositoryId },
        );
        await setColumn(step.itemId, 'Inbox');
        summary('a draft card became an issue (triage picks it up)');
      } else if (step.type === 'add') {
        const a = await ql(
          `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
          { p: board.projectId, c: step.issueId },
        );
        // the next sync moves it on from Inbox to the column its labels say
        await setColumn(a.addProjectV2ItemById.item.id, 'Inbox');
        summary(`#${step.number}: added to the board`);
      } else if (step.type === 'go') {
        await gh.addLabels(step.number, ['agent:go']);
        summary(`#${step.number}: moved to Ready by the owner: agent:go`);
      } else if (step.type === 'move') {
        await setColumn(step.itemId, step.column);
        summary(`#${step.number}: -> ${step.column}`);
      }
    } catch (e) {
      summary(`board step ${step.type} failed: ${e.message}`);
    }
  }
  summary(`board: ${board.url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const token = readTokenFile(process.env.AGENTS_PROJECT_TOKEN_FILE);
  const out = process.env.GITHUB_STEP_SUMMARY;
  const summary = (line) => {
    console.log(line);
    if (out) appendFileSync(out, `- ${line}\n`);
  };
  if (!token) {
    summary('No AGENTS_PROJECT_TOKEN: the board is not synced.');
  } else {
    await runSync({
      ql: createGraphQL(token),
      gh: createGitHub(`${OWNER}/${REPO}`, token),
      config: parseConfig(
        readFileSync(
          new URL('../../.github/agents/config.yml', import.meta.url),
          'utf8',
        ),
      ),
      summary,
    });
  }
}
