/* wren-diary-outbox.js
 * Offline-first outbox for EY diary group entries (food/sleep/nappy etc.).
 * Same pattern as wren-obs-outbox.js: tries online first, queues on failure.
 *
 * Exposes: window.WrenDiaryOutbox  { queue, flush, remove, retryNow, list }
 * DOM events on window:
 *   'wren:diary-outbox-changed'  detail:{ pending, failed }
 *   'wren:diary-outbox-synced'   detail:{ uuid, created }
 */
(function () {
  'use strict';

  var DB_NAME    = 'wren-diary-outbox';
  var DB_VERSION = 1;
  var STORE      = 'queue';
  var MAX_RETRIES   = 8;
  var BASE_BACKOFF  = 15000;          // 15s
  var MAX_BACKOFF   = 30 * 60000;     // 30 min
  var SYNC_INTERVAL = 60000;          // 60s poll

  var _dbPromise = null;
  var _flushing  = false;

  /* ── UUID ────────────────────────────────────────────────────────────────── */
  function uuid() {
    if (window.crypto && crypto.randomUUID) {
      try { return crypto.randomUUID(); } catch (_) {}
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ── IndexedDB ───────────────────────────────────────────────────────────── */
  function _open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('no IDB')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'uuid' });
          os.createIndex('status', 'status', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function ()  { reject(req.error); };
    });
    return _dbPromise;
  }

  function _tx(mode) {
    return _open().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
  }

  function _p(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  function _put(entry) { return _tx('readwrite').then(function (os) { return _p(os.put(entry)); }); }
  function _del(id)    { return _tx('readwrite').then(function (os) { return _p(os.delete(id)); }); }

  function _all() {
    return _tx('readonly').then(function (os) { return _p(os.getAll()); });
  }

  function _emit() {
    _all().catch(function () { return []; }).then(function (items) {
      var pending = items.filter(function (i) { return i.status === 'pending'; }).length;
      var failed  = items.filter(function (i) { return i.status === 'failed'; }).length;
      window.dispatchEvent(new CustomEvent('wren:diary-outbox-changed', { detail: { pending: pending, failed: failed } }));
    });
  }

  /* ── Sync one entry ──────────────────────────────────────────────────────── */
  function _syncEntry(entry) {
    var token = null;
    try { token = sessionStorage.getItem('wrenToken') || sessionStorage.getItem('wren_token') || ''; } catch (_) {}

    // Support {url, body} wrapper (correct shape); fall back to legacy plain payload
    var url  = (entry.payload && entry.payload.url)            ? entry.payload.url  : '/api/diary/group';
    var body = (entry.payload && entry.payload.body !== undefined) ? entry.payload.body : entry.payload;

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? 'Bearer ' + token : '',
      },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      return _del(entry.uuid).then(function () {
        window.dispatchEvent(new CustomEvent('wren:diary-outbox-synced', { detail: { uuid: entry.uuid, created: data.created } }));
        _emit();
      });
    }).catch(function (err) {
      var retries = (entry.retries || 0) + 1;
      var backoff  = Math.min(BASE_BACKOFF * Math.pow(2, retries - 1), MAX_BACKOFF);
      return _put(Object.assign({}, entry, {
        status:       retries >= MAX_RETRIES ? 'failed' : 'pending',
        retries:      retries,
        next_retry:   Date.now() + backoff,
        last_error:   err.message,
      })).then(_emit);
    });
  }

  /* ── Flush pending ───────────────────────────────────────────────────────── */
  function flush() {
    if (_flushing) return Promise.resolve();
    _flushing = true;
    return _all().then(function (items) {
      var now     = Date.now();
      var pending = items.filter(function (i) {
        return i.status === 'pending' && (!i.next_retry || i.next_retry <= now);
      });
      if (!pending.length) { _flushing = false; return; }

      return Promise.all(pending.map(function (e) {
        return _put(Object.assign({}, e, { status: 'syncing' })).then(function () { return _syncEntry(e); });
      })).then(function () { _flushing = false; }, function () { _flushing = false; });
    }).catch(function () { _flushing = false; });
  }

  /* ── Public API ──────────────────────────────────────────────────────────── */
  function queue(payload) {
    var entry = {
      uuid:       uuid(),
      payload:    payload,
      status:     'pending',
      retries:    0,
      created_at: Date.now(),
      next_retry: 0,
    };
    return _put(entry).then(function () {
      _emit();
      if (navigator.onLine) flush();
      return entry.uuid;
    });
  }

  function remove(id) {
    return _del(id).then(_emit);
  }

  function retryNow(id) {
    return _all().then(function (items) {
      var e = items.filter(function (i) { return i.uuid === id; })[0];
      if (!e) return;
      return _put(Object.assign({}, e, { status: 'pending', next_retry: 0 })).then(function () {
        return _syncEntry(e);
      });
    });
  }

  function list() { return _all(); }

  /* ── Auto-sync ───────────────────────────────────────────────────────────── */
  window.addEventListener('online', flush);
  setInterval(function () { if (navigator.onLine) flush(); }, SYNC_INTERVAL);

  window.WrenDiaryOutbox = { queue: queue, flush: flush, remove: remove, retryNow: retryNow, list: list };
}());
