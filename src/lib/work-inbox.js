/**
 * Push a break-glass signal to the work inbox (b266).
 *
 * The work inbox is silent outside working hours except for three categories,
 * and those three are about the building and the children:
 *
 *   safeguarding        a concern being raised
 *   building            fire, flood, intruder, the door station down
 *   child_unaccounted   a child unaccounted for
 *
 * Nothing else belongs here. Not finance, not Ofsted deadlines, not something
 * a member of staff marked "urgent" — those wait for the 08:00 handover like
 * everything else, and the exception only keeps its meaning while it stays
 * this small.
 *
 * Deliberate properties:
 *   - Completely inert unless WORK_INBOX_URL and WORK_INBOX_SECRET are set,
 *     so this ships dark and nothing changes until Toby configures it.
 *   - Fire-and-forget. Never throws, never blocks the request, never turns a
 *     failed notification into a failed safeguarding log.
 *   - Sends the concern REFERENCE, never the child's name. The work vault does
 *     not need to become another store of children's names to be useful —
 *     Toby looks the reference up in Wren.
 */

const BREAK_GLASS = ['safeguarding', 'building', 'child_unaccounted'];
const TIMEOUT_MS = 5000;

function isConfigured() {
  return Boolean(process.env.WORK_INBOX_URL && process.env.WORK_INBOX_SECRET);
}

/**
 * @param {object} item
 * @param {string} item.category  one of BREAK_GLASS
 * @param {string} item.title     short, no child names
 * @param {string} [item.body]    optional detail, no child names
 * @param {string} [item.kind]    note | reminder | task  (default task)
 * @returns {Promise<boolean>}    true if the inbox accepted it
 */
async function pushBreakGlass(item) {
  if (!isConfigured()) return false;
  if (!item || !BREAK_GLASS.includes(item.category)) return false;
  if (!item.title) return false;

  const payload = {
    kind: item.kind || 'task',
    title: String(item.title).slice(0, 200),
    category: item.category,
  };
  if (item.body) payload.body = String(item.body).slice(0, 4000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(process.env.WORK_INBOX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inbox-Secret': process.env.WORK_INBOX_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.status === 202;
  } catch (_e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pushBreakGlass, isConfigured, BREAK_GLASS };
