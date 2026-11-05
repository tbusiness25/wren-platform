'use strict';
/**
 * ask-wren-tools.js — b527 (2026-10-26). The tool catalogue for "Ask Wren".
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * Every tool in here is a THIN WRAPPER over an endpoint Wren already serves,
 * called through src/lib/wren-loopback.js with the caller's own identity. There
 * is no SQL in this file against children, parents or staff, and there must
 * never be: the moment a tool reads a table directly it has stepped outside the
 * gate that protects it (b491's HR allow-list, the EY device gate, the off-site
 * matrix, the capability tiers, the per-row ownership checks). A tool's job is
 * to pick the endpoint, hand over the caller's token, and trim what comes back.
 *
 * So the honest statement about this feature is not "the assistant has been
 * taught the permission rules". It is "the assistant has no permissions of its
 * own at all". If an apprentice opens the Family tab and sees a phone number,
 * the assistant will read it out; if the app refuses them, so does this. That
 * parity is the contract, and scripts/b527-evals.js tests it as parity — the
 * same question through the assistant and through the raw endpoint, compared.
 *
 * ── WHAT IS NARROWED, DELIBERATELY ───────────────────────────────────────────
 * A tool may show the model LESS than the endpoint returned, never more:
 *
 *  · collection passwords  (`password_word`, `collection_password`) are
 *    stripped. A password is a credential, not a contact detail: reading one
 *    into a model prompt and a chat panel is a different act from a member of
 *    staff looking at it on the child's Family tab, and the Family tab is still
 *    where it lives. The tool says so instead.
 *  · why a colleague is off  (`request_type`) is dropped for everybody, which
 *    is b525's rule for the HR "who is off" card. /api/absence/calendar already
 *    masks it for non-managers; this drops it for managers too, because "who is
 *    in on Friday" never needs a reason attached.
 *  · safeguarding is not a tool at all. See the SAFEGUARDING note in
 *    src/routes/ask-wren.js — the question never reaches a tool or the model.
 *  · photo and media URLs are stripped. They are signed per response (b491) and
 *    a signed URL in a chat transcript outlives the answer.
 *
 * ── ADDING A TOOL ────────────────────────────────────────────────────────────
 * One entry below, with: the endpoint it wraps (`endpoint`, for the NOTES table
 * and the status page), the portals it exists on, a `schema` the model can fill
 * in, and a `shape` that trims the response. If the endpoint is not already
 * served on a portal, do NOT add it to that portal's list to "make it work" —
 * the allow-list is the decision, this file only reflects it.
 */

const { callAsUser } = require('./wren-loopback');

// me() is declared below; this alias exists because one tool needs a local
// variable called `me` for the staff row and cannot then call me().
const tools_me = (ctx) => me(ctx);

const MAX_RECORDS = 40;        // per tool result handed to the model
const MAX_TEXT = 600;          // per free-text field (an observation, a note)

// ── trimming helpers ────────────────────────────────────────────────────────
const SECRET_KEYS = /^(password_word|collection_password|pin|pin_hash|totp|token|secret)/i;
const MEDIA_KEYS = /^(photo_url|photo|avatar|attachment|media|signed|thumb)/i;

function clip(v) {
  if (typeof v !== 'string') return v;
  return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…' : v;
}

/** Keep only `keys` from a row, clipping long strings and refusing secrets. */
function pick(row, keys) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const k of keys) {
    if (SECRET_KEYS.test(k) || MEDIA_KEYS.test(k)) continue;
    const v = row[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = clip(v);
  }
  return out;
}

/** Strip every secret/media key anywhere in a structure. Belt and braces over pick(). */
function scrub(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, MAX_RECORDS).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k) || MEDIA_KEYS.test(k)) continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return clip(value);
}

function rowsOf(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of ['rows', 'results', 'children', 'items', 'entries', 'observations',
                   'contacts', 'chunks', 'absences', 'shifts', 'policies', 'next_steps']) {
    if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const todayYmd = () => ymd(Date.now());

// ── the answers a tool can give ─────────────────────────────────────────────
/** A successful result. `records` is what the audit row counts. */
const ok = (data, records, note) => ({ ok: true, data, records: records == null ? 1 : records, note });
/** The app refused. The assistant says this and never works around it. */
const refused = (status, message) => ({
  ok: false, refused: true, status, records: 0,
  message: message || 'You do not have access to that in Wren, so I cannot read it for you either.',
});
/** Nothing to report — not a failure, and NOT a reason to guess. */
const empty = (message) => ({ ok: true, data: null, records: 0, empty: true, message });
const failed = (message) => ({ ok: false, records: 0, message });

/**
 * Turn a loopback response into a tool answer. Every non-2xx becomes a plain
 * refusal carrying the app's own wording where it has one — "the app's answer",
 * which is what the brief asks the assistant to repeat.
 */
function fromResponse(res, shape) {
  if (res.status === 401) return refused(401, 'Your Wren session has expired — sign in again and ask me once more.');
  if (res.status === 403) {
    const m = (res.json && (res.json.message || res.json.error)) || '';
    const why = /device_required/.test(String(res.json && res.json.error))
      ? 'This tablet is not enrolled, so Wren will not show child information on it. '
      : /offsite_restricted/.test(String(res.json && res.json.error))
        ? 'Child information is only available on the nursery network. '
        : '';
    return refused(403, `${why}You do not have access to that in Wren, so I will not read it for you. ${m}`.trim());
  }
  if (res.status === 404) return empty('Wren has no record of that.');
  if (res.status < 200 || res.status >= 300) {
    return failed(`Wren answered ${res.status} when I asked for that, so I have nothing to tell you rather than a guess.`);
  }
  return shape(res.json);
}

// ── who is asking ───────────────────────────────────────────────────────────
/**
 * The caller's own staff record, read through GET /api/staff/:id with their own
 * token (so it is redacted exactly as it is for them). Cached per question.
 * This is how "my room" and "my key children" are resolved — never from a
 * client-supplied room id.
 */
async function me(ctx) {
  if (ctx._me !== undefined) return ctx._me;
  const id = ctx.user && ctx.user.id;
  if (!id) { ctx._me = null; return null; }
  try {
    const res = await callAsUser(ctx.req, { path: `/api/staff/${id}` });
    ctx._me = res.status === 200 && res.json
      ? pick(res.json, ['id', 'first_name', 'last_name', 'preferred_name', 'role', 'job_title', 'room_id', 'room_name'])
      : null;
  } catch (_) { ctx._me = null; }
  return ctx._me;
}

/**
 * Resolve a child NAME to an id through GET /api/children/search — the same
 * search the app's own box uses, with the caller's token, so a child they
 * cannot see is simply not found.
 * @returns {{id:number,label:string}|{ask:string}|{none:string}}
 */
async function resolveChild(ctx, name) {
  const q = String(name || '').trim();
  if (!q) return { none: 'Tell me which child you mean and I will look them up.' };
  if (/^\d+$/.test(q)) return { id: parseInt(q, 10), label: `child #${q}` };
  const res = await callAsUser(ctx.req, { path: '/api/children/search', query: { q, limit: 6 } });
  if (res.status === 403) return { refusedRes: res };
  const hits = rowsOf(res.json);
  if (!hits.length) {
    return { none: `I cannot find a child called "${q}" in what you are allowed to see. Check the spelling, or open the Children list.` };
  }
  const named = hits.map((h) => ({
    id: h.id,
    label: [h.preferred_name || h.first_name, h.last_name].filter(Boolean).join(' '),
    room: h.room_name || null,
  }));
  if (named.length === 1) return named[0];
  const exact = named.filter((h) => h.label.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  return {
    ask: `There is more than one child that matches "${q}": ${named.map((h) => h.label + (h.room ? ` (${h.room})` : '')).join(', ')}. Which one do you mean?`,
    options: named,
  };
}

/** Run `fn` for a resolved child, or return the question/refusal the resolver produced. */
async function withChild(ctx, name, fn) {
  const r = await resolveChild(ctx, name);
  if (r.refusedRes) return fromResponse(r.refusedRes, () => empty());
  if (r.none) return empty(r.none);
  if (r.ask) return { ok: true, data: null, records: 0, clarify: r.ask, message: r.ask };
  return fn(r);
}

// ── the catalogue ───────────────────────────────────────────────────────────
// group: what the router selects on. portals: where the endpoint is actually
// served (HR's allow-list means child data is absent there by design — b491).
const TOOLS = [
  // ── children ─────────────────────────────────────────────────────────────
  {
    name: 'my_room_children',
    group: 'children',
    portals: ['learning'],
    endpoint: 'GET /api/children/by-room/:roomId (room from GET /api/staff/:me)',
    description: "The children ON ROLL in the room you work in — the roll, not today's attendance. For who is actually IN today, use register_today as well.",
    schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      const m = await me(ctx);
      if (!m || !m.room_id) {
        return empty('Your staff record does not have a room on it, so I cannot say "your room". Ask me for a room by name, or for the whole register.');
      }
      const res = await callAsUser(ctx.req, { path: `/api/children/by-room/${m.room_id}` });
      return fromResponse(res, (json) => {
        const rows = rowsOf(json);
        if (!rows.length) return empty(`No children are on roll in ${m.room_name || 'your room'}.`);
        return ok({
          room: m.room_name || `room ${m.room_id}`,
          children: rows.map((r) => pick(r, ['id', 'first_name', 'last_name', 'preferred_name', 'date_of_birth', 'allergies', 'dietary_requirements'])),
        }, rows.length);
      });
    },
  },
  {
    name: 'my_key_children',
    group: 'children',
    portals: ['learning'],
    endpoint: 'GET /api/my-morning/board + GET /api/key-children (names)',
    description: "Your own key children by name, and what is outstanding for each of them — observations, next steps, termly updates, reports. Use for 'my key children', 'what do I owe', 'what is overdue for my children'.",
    schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      // TWO endpoints, because neither answers the whole question.
      //
      // /api/my-morning/board (b286) is the right source for "what is
      // outstanding": one practitioner's caseload across eight strands, scoped
      // server-side to THEIR key children, with the definition of "outstanding"
      // living in src/services/morning-board.js rather than restated here. But
      // it only names a child who HAS something outstanding, so on its own it
      // cannot answer "who are my key children".
      //
      // /api/key-children is the key-person ASSIGNMENT page: every current child
      // grouped by room, each with key_person_id. It is NOT a list of mine —
      // the first cut of this tool handed its whole response to the model and
      // got `{me, rooms:[…]}`, which carries no array this layer recognises, so
      // the tool reported "you have no key children" for somebody with three.
      // Filtering it by key_person_id (and buddy_staff_id) is what makes it the
      // roll call.
      const me = await tools_me(ctx);
      const myId = Number(ctx.user && ctx.user.id);
      const [board, roll] = await Promise.all([
        callAsUser(ctx.req, { path: '/api/my-morning/board' }),
        callAsUser(ctx.req, { path: '/api/key-children' }),
      ]);
      if (roll.status === 403 || roll.status === 401) return fromResponse(roll, () => empty());

      let mine = [], asBuddy = [];
      if (roll.status === 200 && roll.json && Array.isArray(roll.json.rooms)) {
        for (const room of roll.json.rooms) {
          for (const c of (room.children || [])) {
            const row = { name: c.name, room: room.name, date_of_birth: c.date_of_birth };
            if (Number(c.key_person_id) === myId) mine.push(row);
            else if (Number(c.buddy_staff_id) === myId) asBuddy.push(row);
          }
        }
      }

      const out = {
        my_key_children: mine,
        children_i_am_buddy_for: asBuddy,
        room: (me && me.room_name) || null,
      };
      let records = mine.length + asBuddy.length;

      if (board.status === 200 && board.json && Array.isArray(board.json.strands)) {
        const b = board.json;
        out.outstanding = {
          children_in_scope: b.children_in_scope,
          total_outstanding: b.total_outstanding,
          // Only the strands that actually have something owed. A list of eight
          // "nothing to do" lines is noise the model will repeat back.
          by_strand: b.strands
            .filter((st) => st.outstanding > 0)
            .map((st) => ({
              what: st.label, how_many: st.outstanding,
              children: (st.items || []).slice(0, 10).map((i) => ({ name: i.label, detail: i.sub })),
            })),
          nothing_owed_for: b.strands.filter((st) => st.outstanding === 0).map((st) => st.label),
        };
        records += Number(b.total_outstanding || 0);
      }

      if (!mine.length && !asBuddy.length && !out.outstanding) {
        return empty('You have no key children on your record, and there is nothing outstanding for you.');
      }
      if (!mine.length && !asBuddy.length) {
        return ok(out, records, 'Nobody is assigned to you as a key child on your record — the outstanding list above is whatever Wren could scope to you.');
      }
      return ok(out, records);
    },
  },
  {
    name: 'child_summary',
    group: 'children',
    portals: ['learning'],
    endpoint: 'GET /api/children/:id/profile',
    description: "One child's details: room, key person, allergies, dietary needs, medical notes, SEN, funded hours, and the parents on file. Needs the child's name.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name, as staff would say it" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/children/${c.id}/profile` });
        return fromResponse(res, (json) => {
          if (!json) return empty();
          const row = pick(json, [
            'id', 'first_name', 'last_name', 'preferred_name', 'date_of_birth', 'room_name',
            'key_person_first', 'key_person_last', 'allergies', 'dietary_requirements',
            'medical_notes', 'send_needs', 'is_on_sen_register', 'sen_type', 'primary_need',
            'funded_hours', 'funded_hours_type', 'current_funded_hours', 'current_funding_type',
            'parent_1_name', 'parent_1_phone', 'parent_2_name', 'parent_2_phone',
            'emergency_contact_1_name', 'emergency_contact_1_phone', 'notes',
          ]);
          return ok({ child: row }, 1,
            'The collection password is deliberately not shown here — it is on the child\'s Family tab in Wren.');
        });
      });
    },
  },
  {
    name: 'child_dates_and_bookings',
    group: 'children',
    portals: ['learning'],
    endpoint: 'GET /api/children/:id/summary',
    description: "Which days a child is booked in, whether those days are funded, and their expected room move and leaving dates.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/children/${c.id}/summary` });
        return fromResponse(res, (json) => {
          if (!json) return empty();
          return ok({ child: c.label, bookings: scrub(json.bookings), upcoming: scrub(json.upcoming_bookings),
                      any_funded: json.any_funded, allergy: scrub(json.allergy), dates: scrub(json.dates) }, 1);
        });
      });
    },
  },
  {
    name: 'child_contacts',
    group: 'contacts',
    portals: ['learning'],
    endpoint: 'GET /api/children/:id/contacts',
    description: "Everyone on a child's contact list — parents, carers, grandparents — with their relationship and phone number, exactly as the Family tab shows them.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/children/${c.id}/contacts` });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          if (!rows.length) return empty(`Wren holds no contact rows for ${c.label}.`);
          return ok({
            child: c.label,
            contacts: rows.map((r) => pick(r, ['full_name', 'relationship', 'primary_phone', 'primary_email',
                                               'is_emergency_contact', 'parent_slot', 'can_collect', 'collect_proposed'])),
          }, rows.length);
        });
      });
    },
  },
  {
    name: 'child_collection',
    group: 'contacts',
    portals: ['learning'],
    endpoint: 'GET /api/collectors/:childId',
    description: "Who is authorised to collect a child, and whether collection is currently allowed. Does NOT include the collection password.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/collectors/${c.id}` });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          if (!rows.length) return empty(`No named collectors are recorded for ${c.label} — the people on the contact list are who to check.`);
          return ok({
            child: c.label,
            collectors: rows.map((r) => pick(r, ['name', 'relationship', 'phone', 'can_collect', 'notes'])),
          }, rows.length,
            'The collection password is never read out here. Check it on the child\'s Family tab in Wren.');
        });
      });
    },
  },

  // ── development ──────────────────────────────────────────────────────────
  {
    name: 'child_observations',
    group: 'development',
    portals: ['learning'],
    endpoint: 'GET /api/observations/child/:childId',
    description: "A child's recent observations — what was seen, when, and by whom.",
    schema: {
      type: 'object',
      properties: {
        child: { type: 'string', description: "the child's name" },
        limit: { type: 'integer', description: 'how many, newest first (default 8)' },
      },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/observations/child/${c.id}` });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          if (!rows.length) return empty(`There are no observations on Wren for ${c.label}.`);
          const n = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 20);
          return ok({
            child: c.label,
            total_on_record: rows.length,
            observations: rows.slice(0, n).map((r) => pick(r, ['id', 'observation_date', 'created_at', 'title',
                                                              'observation_text', 'next_steps', 'author_name', 'areas'])),
          }, Math.min(rows.length, n));
        });
      });
    },
  },
  {
    name: 'child_progress',
    group: 'development',
    portals: ['learning'],
    endpoint: 'GET /api/observations/child/:childId/framework-summary',
    description: "How a child is getting on against the framework — which areas are covered and which are thin. Use for 'how is X doing', 'what has X not been assessed on'.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/observations/child/${c.id}/framework-summary` });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          const body = rows.length ? rows.map((r) => scrub(r)) : scrub(json);
          if (!body || (Array.isArray(body) && !body.length)) {
            return empty(`Wren has no framework coverage recorded for ${c.label} yet.`);
          }
          return ok({ child: c.label, framework_summary: body }, Array.isArray(body) ? body.length : 1);
        });
      });
    },
  },
  {
    name: 'child_next_steps',
    group: 'development',
    portals: ['learning'],
    endpoint: 'GET /api/next-steps/child/:childId/active',
    description: "A child's open next steps — what we said we would do next and have not done yet.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/next-steps/child/${c.id}/active` });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          if (!rows.length) return empty(`${c.label} has no open next steps on Wren.`);
          return ok({ child: c.label, next_steps: rows.map((r) => pick(r, ['id', 'text', 'description', 'area', 'status', 'created_at', 'target_date'])) }, rows.length);
        });
      });
    },
  },
  {
    name: 'what_to_observe_next',
    group: 'development',
    portals: ['learning'],
    endpoint: 'GET /api/next-steps/suggestions/:child_id',
    description: "Wren's own suggestions for what to observe or work on next with a child, derived from their coverage. Use for 'what should I observe next for X'.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/next-steps/suggestions/${c.id}` });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          const body = rows.length ? rows.map((r) => scrub(r)) : scrub(json);
          if (!body || (Array.isArray(body) && !body.length)) {
            return empty(`Wren cannot suggest a next step for ${c.label} — there is not enough on their record yet. The gap itself is the answer: observe them broadly this week.`);
          }
          return ok({ child: c.label, suggestions: body }, Array.isArray(body) ? body.length : 1);
        });
      });
    },
  },
  {
    name: 'child_diary_today',
    group: 'day',
    portals: ['learning'],
    endpoint: 'GET /api/diary/child/:childId',
    description: "A child's diary for today — meals, sleeps, nappies, what they have done.",
    schema: {
      type: 'object',
      properties: { child: { type: 'string', description: "the child's name" } },
      required: ['child'],
    },
    async run(ctx, args) {
      return withChild(ctx, args.child, async (c) => {
        const res = await callAsUser(ctx.req, { path: `/api/diary/child/${c.id}`, query: { date: todayYmd() } });
        return fromResponse(res, (json) => {
          const rows = rowsOf(json);
          const body = rows.length ? rows.map((r) => scrub(r)) : scrub(json);
          if (!body || (Array.isArray(body) && !body.length)) return empty(`Nothing has been written in ${c.label}'s diary today yet.`);
          return ok({ child: c.label, date: todayYmd(), diary: body }, Array.isArray(body) ? body.length : 1);
        });
      });
    },
  },

  // ── the day ──────────────────────────────────────────────────────────────
  {
    name: 'register_today',
    group: 'day',
    portals: ['learning'],
    endpoint: 'GET /api/attendance/today',
    description: "THE AUTHORITY ON TODAY: who is booked in, who has signed in, who has gone home, who is absent, per room, with headcounts. Use this for any question containing 'today' or 'now' about children being present.",
    schema: {
      type: 'object',
      properties: { room: { type: 'string', description: 'optional room name to narrow to' } },
      required: [],
    },
    async run(ctx, args) {
      const res = await callAsUser(ctx.req, { path: '/api/attendance/today' });
      return fromResponse(res, (json) => {
        let rows = rowsOf(json);
        if (!rows.length) return empty('The register is empty for today.');
        const want = String(args.room || '').trim().toLowerCase();
        if (want) rows = rows.filter((r) => String(r.room_name || '').toLowerCase().includes(want));
        if (!rows.length) return empty(`No children on the register match the room "${args.room}".`);
        const byRoom = {};
        for (const r of rows) {
          const k = r.room_name || 'No room';
          byRoom[k] = byRoom[k] || { booked: 0, in: 0, out: 0, absent: 0 };
          if (r.booked) byRoom[k].booked++;
          if (r.sign_in_time && !r.sign_out_time) byRoom[k].in++;
          if (r.sign_out_time) byRoom[k].out++;
          if (r.absent) byRoom[k].absent++;
        }
        return ok({
          date: todayYmd(),
          headcount_by_room: byRoom,
          children: rows.slice(0, MAX_RECORDS).map((r) => pick(r, ['first_name', 'last_name', 'room_name',
            'booked', 'sign_in_time', 'sign_out_time', 'absent', 'allergies'])),
        }, rows.length);
      });
    },
  },
  {
    name: 'ratios_today',
    group: 'day',
    portals: ['learning'],
    endpoint: 'GET /api/rota/ratio-check?date=',
    description: "Whether each room is within ratio today, using the nursery's own configured ratios (not the generic statutory ones).",
    schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD; today if omitted' } },
      required: [],
    },
    async run(ctx, args) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? args.date : todayYmd();
      const res = await callAsUser(ctx.req, { path: '/api/rota/ratio-check', query: { date } });
      return fromResponse(res, (json) => {
        if (!json) return empty();
        return ok({ date, ratio_check: scrub(json) }, 1);
      });
    },
  },
  {
    name: 'my_shifts',
    group: 'day',
    portals: ['learning', 'hr'],
    endpoint: 'GET /api/rota/my',
    description: "Your own published shifts for the next two weeks — when you are in, and in which room.",
    schema: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      const res = await callAsUser(ctx.req, { path: '/api/rota/my' });
      return fromResponse(res, (json) => {
        const rows = rowsOf(json);
        if (!rows.length) return empty('You have no published shifts in the next two weeks. If that looks wrong, the rota for those weeks may not be published yet.');
        return ok({ shifts: rows.map((r) => pick(r, ['shift_date', 'planned_start', 'planned_end', 'break_mins', 'room_name', 'notes', 'acceptance', 'is_absent'])) }, rows.length);
      });
    },
  },
  {
    name: 'who_is_off',
    group: 'day',
    portals: ['learning', 'hr'],
    endpoint: 'GET /api/absence/calendar?from=&to=',
    description: "Which colleagues are off, and on which dates. Names and dates only — Wren never tells you why somebody is off.",
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, default today' },
        to: { type: 'string', description: 'YYYY-MM-DD, default a week from today' },
      },
      required: [],
    },
    async run(ctx, args) {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(args.from || '')) ? args.from : todayYmd();
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(args.to || '')) ? args.to : ymd(Date.now() + 7 * 864e5);
      const res = await callAsUser(ctx.req, { path: '/api/absence/calendar', query: { from, to } });
      return fromResponse(res, (json) => {
        const rows = rowsOf(json);
        if (!rows.length) return empty(`Nobody is recorded as off between ${from} and ${to}.`);
        // request_type is the REASON. Dropped for every role — see the header.
        return ok({
          from, to,
          off: rows.slice(0, MAX_RECORDS).map((r) => ({
            who: r.staff_name, room: r.room_name || null,
            start: ymd(r.start_date), end: ymd(r.end_date), status: r.status,
          })),
          note: 'Wren never shows you why a colleague is off.',
        }, rows.length);
      });
    },
  },

  // ── knowledge (no child data; available on both portals) ─────────────────
  {
    name: 'eyfs_knowledge',
    group: 'knowledge',
    portals: ['learning', 'hr'],
    endpoint: 'qdrant eyfs_brain_v1 + public.eyfs_brain_chunks FTS (src/lib/eyfs-brain-rag.js) + GET /api/gov-corpus/rag-context',
    description: "What the EYFS framework, the statutory guidance and the nursery's own knowledge base say about a topic — schemas, areas of learning, ratios, the two-year check, safeguarding duties in general terms. Cite the document.",
    schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'the subject to look up, e.g. "schemas", "characteristics of effective learning"' } },
      required: ['topic'],
    },
    async run(ctx, args) {
      const knowledge = require('./ask-wren-knowledge');
      const hits = await knowledge.eyfs(ctx, String(args.topic || ''));
      if (!hits.length) return empty(`Nothing in the EYFS corpus or the knowledge base covers "${args.topic}".`);
      return ok({ topic: args.topic, sources: hits }, hits.length);
    },
  },
  {
    name: 'how_to_use_wren',
    group: 'howto',
    portals: ['learning', 'hr'],
    endpoint: 'qdrant wren_howto_v1 + brain.js _whereIs (tour/help/guide corpus)',
    description: "How to do something in Wren, and which page to do it on — 'how do I record a nappy change', 'where do I write an observation', 'what is new in Wren'. Always gives the page to open.",
    schema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'what the person is trying to do in Wren' } },
      required: ['task'],
    },
    async run(ctx, args) {
      const knowledge = require('./ask-wren-knowledge');
      const hits = await knowledge.howto(ctx, String(args.task || ''));
      if (!hits.length) return empty(`I have nothing written down about "${args.task}" in Wren's own guides.`);
      return ok({ task: args.task, pages: hits }, hits.length);
    },
  },
  {
    name: 'policy_search',
    group: 'policy',
    portals: ['learning', 'hr'],
    endpoint: 'GET /api/policies, GET /api/policies/:id',
    description: "The nursery's own policies and the staff handbook — what OUR policy says, as opposed to what the law says.",
    schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'the policy subject' } },
      required: ['topic'],
    },
    async run(ctx, args) {
      const knowledge = require('./ask-wren-knowledge');
      return knowledge.policies(ctx, String(args.topic || ''));
    },
  },

  // ── the one write ────────────────────────────────────────────────────────
  {
    name: 'send_suggestion',
    group: 'suggest',
    portals: ['learning', 'hr'],
    endpoint: 'POST /api/feedback {kind:"idea"|"works"}',
    writes: true,
    description: "File a feature request, an idea, or 'I saw something good' for Toby. NEVER call this without showing the person the exact words first and getting a yes.",
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'one line' },
        body: { type: 'string', description: 'the detail, in the person\'s own words where possible' },
        kind: { type: 'string', description: '"idea" for a request or change, "works" for praise / something good you saw' },
      },
      required: ['title', 'body'],
    },
    async run(ctx, args) {
      const kind = args.kind === 'works' ? 'works' : 'idea';
      const title = String(args.title || '').trim().slice(0, 300);
      const body = String(args.body || '').trim().slice(0, 5000);
      if (!title) return failed('A suggestion needs a one-line title.');
      const res = await callAsUser(ctx.req, {
        method: 'POST',
        path: '/api/feedback',
        body: {
          kind, title, body,
          portal: ctx.portal === 'hr' ? 'hr' : 'ey',
          page_path: '/ask-wren',
          wren_area: 'ask-wren',
        },
      });
      return fromResponse(res, (json) => ok({
        sent: true, id: json && json.id, kind, title,
        where: 'It is on Toby\'s board now, under feedback.',
      }, 1));
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools that exist on this portal. */
function forPortal(portal) {
  const p = portal === 'hr' ? 'hr' : 'learning';
  return TOOLS.filter((t) => t.portals.includes(p));
}

/** The Ollama `tools` array for a set of tool objects. */
function toOllamaTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
}

module.exports = {
  TOOLS, BY_NAME, forPortal, toOllamaTools,
  me, resolveChild, pick, scrub, rowsOf, fromResponse,
  ok, refused, empty, failed,
  MAX_RECORDS, MAX_TEXT,
};
