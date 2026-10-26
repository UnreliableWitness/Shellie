// The hidden state block the agents keep in a comment they edit in place (spec 3.2):
// a human summary, then `<!-- shellie-agent {json} -->`. Also used for the Agent activity issue's body.
const MARKER = /<!-- shellie-agent (\{.*?\}) -->/s;

/**
 * @param {string} body a comment or issue body
 * @returns {any | null} the parsed block, or null without a valid one
 */
export function parseStatus(body) {
  const m = MARKER.exec(body ?? '');
  if (!m) return null;
  try {
    const value = JSON.parse(m[1]);
    return value && value.v === 1 ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} state
 * @param {string} summary markdown shown to people
 * @returns {string} the summary, then the marker on its own line
 */
export function renderStatus(state, summary) {
  // "-->" can only occur inside a string value; written as - it cannot end the HTML comment early.
  const json = JSON.stringify(state).replace(/-->/g, '\\u002d\\u002d>');
  return `${summary}\n\n<!-- shellie-agent ${json} -->`;
}

/**
 * @param {{ id: number, user: { login: string } | null, body: string }[]} comments in creation order
 * @param {string} botLogin
 * @returns the latest comment by the bot that carries a valid block, or null
 */
export function findStatusComment(comments, botLogin) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.user?.login === botLogin && parseStatus(c.body)) return c;
  }
  return null;
}
