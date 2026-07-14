/* wren-obs-outbox.js  (offlineobs-20260608)
 * ─────────────────────────────────────────────────────────────────────────────
 * Offline-first outbox for EY observations.
 *
 * Online is ALWAYS the default. This module is a pure FALLBACK: the observation
 * form tries a normal online POST first, and only when the device is offline or
 * the network throws does it hand the observation here to be queued in IndexedDB
 * and synced automatically later. Nothing about the existing online path changes.
 *
 * Design:
 *   • One IndexedDB store ("queue") of pending observations, keyed by a
 *     client-generated UUID (used server-side for idempotency so a retry can
 *     never create a duplicate row).
 *   • Each queued entry stores the full obs payload PLUS the raw File/Blob photo
 *     objects (not data-URLs) so multiple photos survive a reload and can be
 *     re-uploaded on sync.
 *   • A group observation (multiple children) is queued as one entry PER CHILD,
 *     mirroring exactly what the online path does (one POST per child).
 *   • Sync runs: on 'online', on app load, and on a periodic timer. For each
 *     pending entry it (1) uploads any pending photo blobs, (2) POSTs the obs
 *     with its client_uuid, (3) deletes the entry ONLY after a confirmed 2xx.
 *     Failures bump a retry counter with exponential backoff; data is never
 *     dropped on failure.
 *
 * Exposes: window.WrenObsOutbox
 * Emits DOM events on window:
 *   'wren:outbox-changed'  detail:{ pending, syncing, failed }
 *   'wren:outbox-synced'   detail:{ uuid, child_id, observation_id }
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var DB_NAME    = 'wren-obs-outbox';
  var DB_VERSION = 1;
  var STORE      = 'queue';

  var MAX_RETRIES   = 8;
  var BASE_BACKOFF  = 15 * 1000;          // 15s, doubles each retry
  var MAX_BACKOFF   = 30 * 60 * 1000;     // cap at 30 min
  var SYNC_INTERVAL = 60 * 1000;          // periodic flush every 60s

  var _dbPromise = null;
  var _flushing  = false;
  var _timer     = null;

  /* ── UUID (RFC4122 v4) ─────────────────────────────────────────────────── */
  function uuid() {
    if (window.crypto && crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch (_) {}
    }
    // Fallback for older webviews
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (window.crypto && crypto.getRandomValues)
        ? crypto.getRandomValues(new Uint8Array(1))[0] & 15
        : Math.floor(Math.random() * 16);
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* ── IndexedDB open ────────────────────────────────────────────────────── */
  function _open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'uuid' });
          os.createIndex('status',     'status',     { unique: false });
          os.createIndex('created_at', 'created_at', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function ()  { reject(req.error || new Error('IDB open failed')); };
    });
    return _dbPromise;
  }

  function _tx(mode) {
    return _open().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function _reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  /* ── CRUD ──────────────────────────────────────────────────────────────── */
  function _put(entry) {
    return _tx('readwrite').then(function (os) { return _reqToPromise(os.put(entry)); });
  }
  function _get(uuid) {
    return _tx('readonly').then(function (os) { return _reqToPromise(os.get(uuid)); });
  }
  function _delete(uuid) {
    return _tx('readwrite').then(function (os) { return _reqToPromise(os.delete(uuid)); });
  }
  function _all() {
    return _tx('readonly').then(function (os) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var cur = os.openCursor();
        cur.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { out.push(c.value); c.continue(); }
          else   { resolve(out); }
        };
        cur.onerror = function () { reject(cur.error); };
      });
    }).catch(function () { return []; });
  }

  /* ── Status broadcast ──────────────────────────────────────────────────── */
  function _broadcast() {
    return counts().then(function (c) {
      try {
        window.dispatchEvent(new CustomEvent('wren:outbox-changed', { detail: c }));
      } catch (_) {}
      return c;
    });
  }

  function counts() {
    return _all().then(function (list) {
      var pending = 0, syncing = 0, failed = 0, draft = 0;
      list.forEach(function (e) {
        if (e.status === 'syncing')      syncing++;
        else if (e.status === 'failed')  failed++;
        else if (e.status === 'draft')   draft++;
        else                             pending++;
      });
      return { pending: pending, syncing: syncing, failed: failed, draft: draft, total: list.length };
    });
  }

  /* ── Enqueue ───────────────────────────────────────────────────────────────
   * `obs`   — the JSON payload that would have gone to POST /api/observations
   *           for ONE child (caller queues one per child for group obs).
   * `photos`— array of File/Blob objects to upload on sync. Stored raw.
   * Returns the created entry's uuid.
   * ──────────────────────────────────────────────────────────────────────── */
  function enqueue(obs, photos, opts) {
    var id = (obs && obs.client_uuid) || uuid();
    var initialStatus = (opts && opts.status) || 'pending';
    var entry = {
      uuid:        id,
      status:      initialStatus,      // pending | syncing | failed | draft
      retries:     0,
      next_attempt_at: 0,              // epoch ms; 0 = eligible now
      last_error:  null,
      created_at:  Date.now(),
      // Photos already uploaded online (URLs) keep their place; blobs are the
      // photos that still need uploading when this entry syncs.
      obs:         Object.assign({}, obs, { client_uuid: id }),
      photo_blobs: (photos || []).filter(Boolean),
      // child label snapshot for the pending-sync UI (no network needed to show it)
      child_label: (obs && obs._child_label) || null
    };
    // _child_label is a UI hint only — don't send it to the server.
    if (entry.obs._child_label) delete entry.obs._child_label;
    return _put(entry).then(function () {
      _broadcast();
      _scheduleFlush(1500);
      return id;
    });
  }

  /* ── Manual ops for the drafts / pending-sync UI ───────────────────────── */
  function list() { return _all(); }

  function remove(uuid) {
    return _delete(uuid).then(function () { return _broadcast(); });
  }

  function retryNow(uuid) {
    return _get(uuid).then(function (e) {
      if (!e) return;
      e.status = 'pending';
      e.retries = 0;
      e.next_attempt_at = 0;
      e.last_error = null;
      return _put(e);
    }).then(function () { return flush(true); });
  }

  /* ── Photo upload (one entry's blobs) ──────────────────────────────────── */
  function _uploadBlobs(blobs) {
    if (!blobs || !blobs.length) return Promise.resolve([]);
    var token = sessionStorage.getItem('wrenToken') || '';
    var fd = new FormData();
    blobs.forEach(function (b, i) {
      var name = (b && b.name) || ('photo-' + i + '.jpg');
      fd.append('photos', b, name);
    });
    return fetch('/api/observations/upload', {
      method: 'POST',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      body: fd
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; })
        .then(function (d) { throw new Error(d.error || ('upload HTTP ' + r.status)); });
      return r.json();
    }).then(function (data) {
      return (data && data.urls) || [];
    });
  }

  /* ── POST one observation ──────────────────────────────────────────────── */
  function _postObs(payload) {
    var token = sessionStorage.getItem('wrenToken') || '';
    return fetch('/api/observations', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { 'Authorization': 'Bearer ' + token } : {}
      ),
      body: JSON.stringify(payload)
    }).then(function (r) {
      // 401 — token expired; leave the entry queued (don't burn a retry), the
      // user will re-auth and the next flush will pick it up.
      if (r.status === 401) { var e = new Error('unauthorised'); e.authFail = true; throw e; }
      if (!r.ok) return r.json().catch(function () { return {}; })
        .then(function (d) { var e = new Error(d.error || ('HTTP ' + r.status)); e.http = r.status; throw e; });
      return r.json();
    });
  }

  function _backoff(retries) {
    return Math.min(BASE_BACKOFF * Math.pow(2, retries), MAX_BACKOFF);
  }

  /* ── Sync a single entry. Resolves true if removed (success), false if left
   *    queued. Never throws — failures are recorded on the entry. ─────────── */
  function _syncEntry(entry) {
    // mark syncing
    entry.status = 'syncing';
    return _put(entry).then(_broadcast).then(function () {
      // 1) Upload any pending photo blobs, merge URLs into the payload.
      return _uploadBlobs(entry.photo_blobs).then(function (urls) {
        var payload = Object.assign({}, entry.obs);
        var existing = Array.isArray(payload.photo_urls) ? payload.photo_urls.slice() : [];
        payload.photo_urls = existing.concat(urls);
        // 2) POST the obs (idempotent server-side via client_uuid).
        return _postObs(payload);
      });
    }).then(function (result) {
      // Confirmed 2xx — only NOW remove from the outbox.
      return _delete(entry.uuid).then(function () {
        try {
          window.dispatchEvent(new CustomEvent('wren:outbox-synced', {
            detail: { uuid: entry.uuid, child_id: entry.obs.child_id, observation_id: result && result.id }
          }));
        } catch (_) {}
        _broadcast();
        return true;
      });
    }).catch(function (err) {
      // Re-fetch in case it changed; record failure + schedule backoff.
      return _get(entry.uuid).then(function (cur) {
        if (!cur) return false;       // already removed elsewhere
        if (err && err.authFail) {
          // Don't penalise on auth failure — just requeue as pending.
          cur.status = 'pending';
          cur.next_attempt_at = Date.now() + 30 * 1000;
        } else {
          cur.retries = (cur.retries || 0) + 1;
          cur.last_error = (err && err.message) || 'sync failed';
          cur.next_attempt_at = Date.now() + _backoff(cur.retries);
          cur.status = cur.retries >= MAX_RETRIES ? 'failed' : 'pending';
        }
        return _put(cur).then(_broadcast).then(function () { return false; });
      });
    });
  }

  /* ── Flush the whole queue (sequential, respects backoff windows) ──────── */
  function flush(force) {
    if (_flushing) return Promise.resolve();
    if (!navigator.onLine) return Promise.resolve();
    if (!sessionStorage.getItem('wrenToken')) return Promise.resolve(); // not logged in
    _flushing = true;
    return _all().then(function (list) {
      var now = Date.now();
      // eligible = not currently mid-sync, past its backoff window (unless forced),
      // and not permanently failed (those need a manual retry).
      var queue = list.filter(function (e) {
        if (e.status === 'draft') return false;   // explicit drafts never auto-sync
        if (e.status === 'failed' && !force) return false;
        if (e.status === 'syncing') return false;
        if (!force && e.next_attempt_at && e.next_attempt_at > now) return false;
        return true;
      }).sort(function (a, b) { return a.created_at - b.created_at; });

      // Process sequentially so retries/backoff stay sane and we don't hammer.
      return queue.reduce(function (p, entry) {
        return p.then(function () {
          if (!navigator.onLine) return;        // bail if we dropped offline mid-flush
          return _syncEntry(entry);
        });
      }, Promise.resolve());
    }).catch(function () { /* swallow — outbox must never throw into the app */ })
      .then(function () { _flushing = false; });
  }

  var _flushTimeout = null;
  function _scheduleFlush(delay) {
    clearTimeout(_flushTimeout);
    _flushTimeout = setTimeout(function () { flush(false); }, delay || 0);
  }

  /* ── Wiring: online event, app load, periodic timer ────────────────────── */
  function _start() {
    window.addEventListener('online', function () {
      _broadcast();
      _scheduleFlush(800);
    });
    window.addEventListener('offline', function () { _broadcast(); });
    // Periodic safety net (also catches backoff windows expiring).
    if (!_timer) _timer = setInterval(function () { flush(false); }, SYNC_INTERVAL);
    // Initial flush + status paint shortly after load.
    _broadcast();
    _scheduleFlush(2000);
  }

  // Public API
  window.WrenObsOutbox = {
    uuid:     uuid,
    enqueue:  enqueue,
    list:     list,
    counts:   counts,
    flush:    flush,
    retryNow: retryNow,
    remove:   remove
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    _start();
  }
}());
