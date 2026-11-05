'use strict';
/**
 * door intercom client (b195, 2026-08-19) — HTTP Digest transport for the door console.
 *
 * WHY A NEW LIB: src/routes/doorbell.js (b99) has its own private copy of this digest
 * client. That router stays untouched and mounted — this lib exists so the b195
 * /api/door console can share ONE tested transport without editing a live prod route.
 * Consolidating the two is a follow-up for a Claude review pass (see NOTES).
 *
 * Verified against DHI-VTO4202FB-P-S2, firmware 4.511.10EX002.0.R, 2026-08-19:
 *   /cgi-bin/snapshot.cgi?channel=1                                   → 200, ~141 KB JPEG
 *   /cgi-bin/accessControl.cgi?action=getDoorStatus&channel=1         → 200, "Info.status=Close"
 *   /cgi-bin/accessControl.cgi?action=openDoor&channel=1&Type=Remote  → present, NEVER fired in testing
 *
 * CREDENTIALS: env first (DAHUA_ADMIN_USER / DAHUA_ADMIN_PASS), then a read-only
 * fallback parse of /run/secrets/ladn-ops.env — which is bind-mounted read-only
 * into both wren-ladn and wren-ladn-dev at the same path. The password is never logged,
 * never returned by any accessor, and never leaves this module.
 */

const http   = require('http');
const fs     = require('fs');
const crypto = require('crypto');

const OPS_ENV = process.env.LADN_OPS_ENV || '/run/secrets/ladn-ops.env';

// ── Credential resolution ─────────────────────────────────────────────────────
// Cached so we parse the secrets file at most once per process (and re-try only
// if it was missing, in case the mount appears later).
let _fileCreds = null;      // { user, pass } | null
let _fileCredsTried = false;

function _readOpsEnv() {
  if (_fileCredsTried && _fileCreds) return _fileCreds;
  _fileCredsTried = true;
  try {
    const txt = fs.readFileSync(OPS_ENV, 'utf8');
    const pick = (key) => {
      // KEY=value / export KEY="value" / KEY='value'
      const m = txt.match(new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=\\s*(.+)$', 'm'));
      if (!m) return '';
      return m[1].trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    };
    const user = pick('DAHUA_ADMIN_USER') || pick('DAHUA_USER');
    const pass = pick('DAHUA_ADMIN_PASS') || pick('DAHUA_PASS');
    _fileCreds = (user && pass) ? { user, pass } : null;
  } catch {
    _fileCreds = null;      // not mounted / not readable — env-only from here
  }
  return _fileCreds;
}

function host()    { return process.env.DAHUA_IP || process.env.DAHUA_HOST || '192.0.2.10'; }
function timeout() { return parseInt(process.env.DAHUA_HTTP_TIMEOUT_MS || '4000', 10) || 4000; }

function _user() {
  return process.env.DAHUA_ADMIN_USER || process.env.DAHUA_USER || (_readOpsEnv() || {}).user || 'admin';
}
function _pass() {
  return process.env.DAHUA_ADMIN_PASS || process.env.DAHUA_PASS || (_readOpsEnv() || {}).pass || '';
}

/** Are credentials available at all? Booleans only — never the secret itself. */
function isConfigured() { return !!_pass(); }

/** Where the creds came from, for the config endpoint / NOTES. Never the value. */
function credSource() {
  if (process.env.DAHUA_ADMIN_PASS || process.env.DAHUA_PASS) return 'env';
  if ((_readOpsEnv() || {}).pass) return 'secrets-file';
  return 'none';
}

// ── HTTP Digest ───────────────────────────────────────────────────────────────
function _parseDigest(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(header)) !== null) out[m[1]] = (m[2] !== undefined ? m[2] : m[3]);
  return out;
}
const _md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/**
 * GET a VTO CGI path, transparently answering a Digest 401.
 * Resolves { status, headers, body } — body is a Buffer when binary, else a string.
 * Rejects only on network error / timeout.
 */
function dahuaGet(pathAndQuery, { binary = false } = {}) {
  const h = host(), user = _user(), pass = _pass(), uri = pathAndQuery, to = timeout();

  const doRequest = (authHeader) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: h, port: 80, method: 'GET', path: uri, timeout: to,
        headers: authHeader ? { Authorization: authHeader } : {} },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
        }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout after ${to}ms`)));
    req.end();
  });

  return doRequest(null).then((first) => {
    if (first.status !== 401) return first;
    const wwwAuth = first.headers['www-authenticate'] || '';
    if (!/digest/i.test(wwwAuth)) return first;
    const d = _parseDigest(wwwAuth);
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const qop = (d.qop || '').split(',')[0].trim() || 'auth';
    const ha1 = _md5(`${user}:${d.realm}:${pass}`);
    const ha2 = _md5(`GET:${uri}`);
    const response = _md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    let auth = `Digest username="${user}", realm="${d.realm}", nonce="${d.nonce}", ` +
               `uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", ` +
               `response="${response}", algorithm=${d.algorithm || 'MD5'}`;
    if (d.opaque) auth += `, opaque="${d.opaque}"`;
    return doRequest(auth);
  });
}

// ── Device operations ─────────────────────────────────────────────────────────
const SNAPSHOT_PATH = () => process.env.DAHUA_SNAPSHOT_PATH || '/cgi-bin/snapshot.cgi?channel=1';
const DOOR_CHANNEL  = () => {
  // Door channel is 1 on this unit (getDoorStatus&channel=1 → Info.status=Close).
  const n = parseInt(process.env.DAHUA_DOOR_CHANNEL_B195 || '1', 10);
  return Number.isFinite(n) ? n : 1;
};

/** Live JPEG from the doorway camera. Throws on unreachable. */
async function getSnapshot() {
  const r = await dahuaGet(SNAPSHOT_PATH(), { binary: true });
  if (r.status >= 200 && r.status < 300 && r.body && r.body.length) {
    return { buffer: r.body, contentType: r.headers['content-type'] || 'image/jpeg' };
  }
  const err = new Error(`snapshot HTTP ${r.status}`);
  err.httpStatus = r.status;
  throw err;
}

/**
 * Door lock state. Parses "Info.status=Close" (Close = locked/shut on Dahua).
 * Returns { raw, status: 'closed'|'open'|'unknown', http_status }.
 */
async function getDoorStatus() {
  const r = await dahuaGet(`/cgi-bin/accessControl.cgi?action=getDoorStatus&channel=${DOOR_CHANNEL()}`);
  const raw = String(r.body || '').trim();
  let status = 'unknown';
  const m = raw.match(/status\s*=\s*(\w+)/i);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === 'close' || v === 'closed') status = 'closed';
    else if (v === 'open' || v === 'opened') status = 'open';
  }
  return { raw: raw.slice(0, 200), status, http_status: r.status };
}

/**
 * ⚠️ PHYSICALLY RELEASES THE DOOR at a nursery entrance.
 * Only ever call this from an explicit, authenticated, on-site staff action that has
 * already been written to ladn.door_events. Guarded by DOOR_OPEN_ENABLED so a dev box
 * cannot fire it by accident — dev/testing runs the dry-run path instead.
 */
async function openDoor() {
  const ch = DOOR_CHANNEL();
  const tpl = process.env.DAHUA_OPEN_PATH;
  const p = tpl ? tpl.replace(/\$\{channel\}/g, String(ch))
                : `/cgi-bin/accessControl.cgi?action=openDoor&channel=${ch}&Type=Remote`;
  const r = await dahuaGet(p);
  const ok2xx = r.status >= 200 && r.status < 300;
  return {
    success: ok2xx && (/ok/i.test(String(r.body || '')) || ok2xx),
    http_status: r.status,
    body: String(r.body || '').slice(0, 200),
    action: 'accessControl.openDoor',
    channel: ch,
  };
}

/** Live opens require an explicit opt-in AND working creds. Default: OFF. */
function liveOpenEnabled() {
  return process.env.DOOR_OPEN_ENABLED === 'true' && isConfigured();
}


// ── Access cards (b199 2026-08-19, re-probed and corrected b250 2026-09-01) ──
// PROBED LIVE against DHI-VTO4202FB-P-S2 (firmware 4.511.10EX002.0.R). Every call
// below was run for real, then undone — the device was left at Size=0 both times:
//
//   recordFinder.cgi?action=getQuerySize&name=AccessControlCard   → "Size=0"        ✅
//   recordFinder.cgi?action=find&name=AccessControlCard&count=N   → records[i].…    ✅
//   recordUpdater.cgi?action=insert&name=AccessControlCard&…      → "RecNo=1"       ✅
//   recordUpdater.cgi?action=remove&name=AccessControlCard&recno= → "OK"            ✅
//
// THREE THINGS THE PROBES ESTABLISHED, and they all matter:
//
//   1. The insert needs the FULL field set. A minimal insert (CardNo+UserID only)
//      is rejected with HTTP 400 "Bad Request!", and Doors[0] must reach the device
//      percent-encoded (Doors%5B0%5D) or the whole request 400s.
//
//   2. ⚠️ ValidDateStart / ValidDateEnd / IsValid CANNOT BE SET ON THIS FIRMWARE.
//      b250 re-tested this on 2026-09-01 specifically to try to disprove b199, and
//      could not. Eight attempts, all against the real device:
//        · insert with dates, space separator            → ValidDate*=0000-00-00, IsValid=false
//        · insert with dates + IsValid=true              → unchanged
//        · insert with IsValid=true alone                → unchanged
//        · insert with dates + IsValid + UseTime=0       → UseTime STORED as 0, dates unchanged
//        · insert with ISO "T" separator + IsValid       → unchanged
//        · update (recno, partial field set)             → HTTP 400 Bad Request
//        · update with the FULL field set + dates + IsValid → HTTP 200 "OK", and the
//          read-back STILL shows IsValid=false / 0000-00-00. The device acknowledges
//          the write and discards those three fields.
//      There is also no second table holding validity: AccessControlFace,
//      AccessControlPassword, AccessUser, AccessControlTimeSection, PersonInfo and
//      AccessControlAuth all return "Bad Request!" on this firmware. AccessControlCard
//      is the only card store, and IsValid is derived, not settable.
//
//      SO: the dates below are sent anyway (harmless, and a firmware update would
//      start honouring them), but NOTHING in Wren may gate on IsValid — a gate on it
//      would refuse every enrolment this device is capable of. What Wren verifies
//      instead is PRESENCE: the card is read back from the device by CardNo before
//      the Wren row is marked active. The only proof a fob actually opens the door
//      is the first successful swipe, which arrives at /api/clockin/dahua-webhook
//      and is what the Roost keyring shows as "last swipe".
//
//   3. RecNo is assigned by the DEVICE and is NOT stable across deletes — it is not
//      the card UID. Store it for reference, but always re-resolve by CardNo before
//      a destructive call. findCard()/findCardRecNo() below are that re-resolution.
//
// Capacity is 1000 (AccessControlCardRec → Size=1000). Cards only on this unit:
// no face, no PIN. One door, AccessControl[0].Name=Door1.

const CARD_NAME = 'AccessControlCard';
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * "YYYY-MM-DD hh:mm:ss" in LOCAL time — the format the VTO itself reports, and the
 * device runs on nursery local time. Built from getFullYear()/getMonth()/... rather
 * than toISOString(), which would silently shift the date by an hour through BST.
 */
function _dahuaDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Are we allowed to WRITE cards to the device? Explicit opt-in, default OFF. */
function cardWriteEnabled() {
  return process.env.DOOR_CARD_WRITE_ENABLED === 'true' && isConfigured();
}

/** Parse Dahua's "records[0].Key=value" body into an array of plain objects. */
function _parseRecords(body) {
  const out = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    const m = line.match(/^records\[(\d+)\]\.([A-Za-z0-9_[\]]+)=(.*)$/);
    if (!m) continue;
    const i = Number(m[1]);
    out[i] = out[i] || {};
    out[i][m[2]] = m[3];
  }
  return out.filter(Boolean);
}

/** How many cards the VTO holds. Returns a number, or null when unreachable. */
async function cardCount() {
  const r = await dahuaGet(`/cgi-bin/recordFinder.cgi?action=getQuerySize&name=${CARD_NAME}`);
  const m = String(r.body || '').match(/Size\s*=\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Every card enrolled on the VTO, normalised to the shape Wren cares about.
 * card_no is upper-cased so it compares directly against ladn.staff_fobs.fob_uid,
 * which handleFobEvent also upper-cases.
 */
async function listCards({ count = 200 } = {}) {
  const r = await dahuaGet(`/cgi-bin/recordFinder.cgi?action=find&name=${CARD_NAME}&count=${count}`);
  return _parseRecords(r.body).map(rec => ({
    recno:     rec.RecNo ? parseInt(rec.RecNo, 10) : null,
    card_no:   (rec.CardNo || '').toUpperCase().trim(),
    card_name: rec.CardName || rec.UserName || '',
    user_id:   rec.UserID || '',
    card_type: rec.CardType || '',
    status:    rec.CardStatus || '',
    is_valid:  rec.IsValid === 'true',
  }));
}

/**
 * The card the device holds for this number, or null if it holds none.
 *
 * THIS IS THE VERIFICATION PRIMITIVE. Wren never marks a fob active on the strength
 * of an insert returning RecNo — it re-reads the card table and confirms the card is
 * actually there. Same call before every destructive operation, because RecNo is the
 * device's own row number and shifts when other cards are removed.
 *
 * Rejects on transport failure (unreachable) — a caller MUST NOT treat that as
 * "not present", which is why this throws rather than returning null on error.
 */
async function findCard(cardNo) {
  const want = String(cardNo || '').toUpperCase().trim();
  if (!want) return null;
  const cards = await listCards({ count: 500 });
  return cards.find(c => c.card_no === want) || null;
}

/** The RecNo the device holds for a card number, or null if it has none. */
async function findCardRecNo(cardNo) {
  const hit = await findCard(cardNo);
  return hit ? hit.recno : null;
}

/**
 * Enrol a card on the VTO. Resolves { ok, recno, dry_run, raw }.
 *
 * Never throws for a device refusal — the caller needs to distinguish "device said
 * no" from "device unreachable" so it can decide whether to roll the Wren row back,
 * so a refusal comes back as ok:false and only a transport failure rejects.
 */
async function insertCard({ card_no, card_name, user_id, door = 0, valid_from, valid_to }) {
  const cardNo = String(card_no || '').toUpperCase().trim();
  if (!cardNo) throw new Error('card_no required');
  // The device rejects most punctuation in the name field; keep it to what a Dahua
  // UI would accept and cap it at the length the firmware stores.
  const name = String(card_name || 'WREN').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 30) || 'WREN';
  const uid  = String(user_id || '').replace(/\D/g, '') || '1';

  if (!cardWriteEnabled()) {
    return { ok: true, dry_run: true, recno: null,
             raw: 'DRY-RUN — DOOR_CARD_WRITE_ENABLED is not true, nothing written to the VTO' };
  }

  // Validity window. Sent on every insert even though THIS firmware discards it
  // (see note 2 above) — it costs one query parameter, it is what the device would
  // want on any firmware that does honour it, and sending it keeps the read-back
  // assertion meaningful the day that changes. Format is the one the device itself
  // reports on read-back: "YYYY-MM-DD hh:mm:ss".
  const from = _dahuaDate(valid_from) || _dahuaDate(new Date());
  const to   = _dahuaDate(valid_to)   || _dahuaDate(new Date(Date.now() + TEN_YEARS_MS));

  // Doors[0] MUST be percent-encoded — the raw brackets 400 on this firmware.
  const q = `/cgi-bin/recordUpdater.cgi?action=insert&name=${CARD_NAME}` +
            `&CardName=${encodeURIComponent(name)}&UserName=${encodeURIComponent(name)}` +
            `&CardNo=${encodeURIComponent(cardNo)}&UserID=${encodeURIComponent(uid)}` +
            `&CardStatus=0&CardType=0&Doors%5B0%5D=${encodeURIComponent(door)}` +
            `&UseTime=-1` +
            `&ValidDateStart=${encodeURIComponent(from)}&ValidDateEnd=${encodeURIComponent(to)}`;
  const r = await dahuaGet(q);
  const m = String(r.body || '').match(/RecNo\s*=\s*(\d+)/i);
  return {
    ok: r.status >= 200 && r.status < 300 && !!m,
    dry_run: false,
    recno: m ? parseInt(m[1], 10) : null,
    http_status: r.status,
    raw: String(r.body || '').trim().slice(0, 200),
  };
}

/**
 * Remove a card from the VTO by RecNo. Same contract as insertCard: a device
 * refusal is ok:false, only a transport failure rejects.
 */
async function removeCard(recno) {
  const n = parseInt(recno, 10);
  if (!Number.isFinite(n)) throw new Error('recno required');
  if (!cardWriteEnabled()) {
    return { ok: true, dry_run: true,
             raw: 'DRY-RUN — DOOR_CARD_WRITE_ENABLED is not true, nothing removed from the VTO' };
  }
  const r = await dahuaGet(`/cgi-bin/recordUpdater.cgi?action=remove&name=${CARD_NAME}&recno=${n}`);
  const body = String(r.body || '').trim();
  return {
    ok: r.status >= 200 && r.status < 300 && /ok/i.test(body),
    dry_run: false,
    http_status: r.status,
    raw: body.slice(0, 200),
  };
}

module.exports = {
  dahuaGet, getSnapshot, getDoorStatus, openDoor,
  isConfigured, credSource, liveOpenEnabled,
  host, doorChannel: DOOR_CHANNEL,
  // b199 — access-card CRUD (see the probe notes above)
  cardWriteEnabled, cardCount, listCards, findCard, findCardRecNo, insertCard, removeCard,
  // b250 — date formatter shared with the verification harness
  _dahuaDate,
};
