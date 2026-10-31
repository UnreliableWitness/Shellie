// What one sync of the project board does, as a plan (tools/agents/project.mjs carries it out on GitHub):
// draft cards become issues, open issues not on the board are added, a needs-owner card the owner dragged to
// Ready becomes agent:go, and every other card is moved to the column its labels say.
import { columnFor, ownerIntent } from './project-columns.mjs';

const REPO = 'UnreliableWitness/Shellie';

/**
 * @param {{ board: { itemId: string, column: string | null, content: any }[],
 *   issues: { id: string, number: number, labels: string[], state: string }[],
 *   waitsForOwner: Set<number>, skip: Set<number> }} o
 *   board: the project's cards; issues: the repo's open issues; waitsForOwner: issues whose agent PR waits for
 *   the owner; skip: issues that never go on the board (the Agent activity issue)
 * @returns {({ type: 'convert', itemId: string } | { type: 'add', issueId: string, number: number }
 *   | { type: 'go', number: number } | { type: 'move', itemId: string, number: number, column: string })[]}
 */
export function planSync({ board, issues, waitsForOwner, skip }) {
  const plan = [];
  const onBoard = new Set();
  for (const card of board) {
    if (card.content?.type === 'DraftIssue') {
      plan.push({ type: 'convert', itemId: card.itemId });
      continue;
    }
    const c = card.content;
    if (c?.type !== 'Issue' || c.repo !== REPO) continue;
    onBoard.add(c.number);
    if (skip.has(c.number)) continue;
    const issue = { state: c.state, labels: c.labels };
    if (ownerIntent({ column: card.column, issue }) === 'go') {
      plan.push({ type: 'go', number: c.number });
      continue;
    }
    const column = columnFor(issue, {
      prWaitsForOwner: waitsForOwner.has(c.number),
    });
    if (column !== card.column)
      plan.push({
        type: 'move',
        itemId: card.itemId,
        number: c.number,
        column,
      });
  }
  for (const i of issues)
    if (!onBoard.has(i.number) && !skip.has(i.number))
      plan.push({ type: 'add', issueId: i.id, number: i.number });
  return plan;
}

/** @returns {Map<number, number>} issue number to its position among the Ready cards, top first */
export function readyRank(board) {
  const rank = new Map();
  for (const card of board)
    if (
      card.column === 'Ready' &&
      card.content?.type === 'Issue' &&
      card.content.repo === REPO
    )
      rank.set(card.content.number, rank.size);
  return rank;
}
