'use strict';
/**
 * b308 — one place the three archive scripts agree on where they are running.
 *
 * The leaver job, the sweep and the backup all need three things settled before
 * anything else loads: which database, how to reach it, and where the archive
 * root is. Two of those differ depending on whether the script is running on the
 * host (cron, a person at a terminal) or inside the app container.
 *
 * editions/ladn/.env carries PG_HOST=wren-postgres and PG_DB=wren. Inside the
 * container both are right. On the host neither is: the container name does not
 * resolve, and `wren` is PRODUCTION. So the rule is
 *
 *   · a --db flag always wins over the .env value, and
 *   · PG_HOST=wren-postgres from the host means localhost:5434
 *     (the convention scripts/apprentice-rag-ingest.js and friends already use).
 *
 * Getting the first of those wrong points a leaver archive at the live nursery
 * database; getting it silently wrong is worse. Hence the explicit-flag rule the
 * scripts enforce on top of this.
 */
const path = require('path');

/**
 * @param {string|null} dbFlag  the --db argument, or null
 * @returns {{db:string, host:string, port:number}}
 */
function configure(dbFlag) {
  if (dbFlag) process.env.PG_DB = dbFlag;
  require('dotenv').config({
    path: path.join(__dirname, '../../editions/ladn/.env'),
    override: false,
    quiet: true,
  });
  // .env sets PG_DB=wren (production). override:false means it will NOT clobber
  // a value we already set — but it does fill one in if the flag was absent, so
  // re-assert the flag either way.
  if (dbFlag) process.env.PG_DB = dbFlag;

  if (process.env.PG_HOST === 'wren-postgres' && !insideContainer()) {
    process.env.PG_HOST = '127.0.0.1';
    process.env.PG_PORT = process.env.PG_PORT_HOST || '5434';
  }
  return {
    db: process.env.PG_DB,
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5434),
  };
}

/** Inside the app image the postgres container name resolves; on the host it does not. */
function insideContainer() {
  try { return require('fs').existsSync('/app/src'); } catch (_) { return false; }
}

/** The archive root, in one place, with the env override the scripts document. */
function archiveRoot(flagValue) {
  return flagValue || process.env.WREN_ARCHIVE_ROOT || '/app-archive';
}

/** Media source root, which differs between the prod and dev data directories. */
function uploadsRoot(flagValue, db) {
  if (flagValue) return flagValue;
  if (process.env.WREN_UPLOADS_ROOT) return process.env.WREN_UPLOADS_ROOT;
  const dir = /_dev$/i.test(db || '') ? 'ladn-dev' : 'ladn';
  return path.join('/app/data', dir, 'uploads');
}

/**
 * b321 — the SECOND media store, and the reason the archive could not see it.
 *
 * person_documents (b104) does not write into the uploads tree. It writes to
 * <data>/person-documents/<subject_type>/<subject_id>/, and it stores the
 * CONTAINER spelling of that path — /app/data/person-documents/child/123/x.jpg.
 * b308 declared person_documents.stored_path as a media column, but every one
 * of those paths resolved outside the uploads root and was logged
 * "NOT copied", so the archive held the RECORD of each uploaded document and
 * never the document itself. For a b321 family photo that is not cosmetic: the
 * handover class exists precisely so the picture is offered back and then
 * deleted, and a file the sweep cannot find is a file that is never deleted.
 *
 * Derived from uploadsRoot() rather than spelled out again, so the data
 * directory's layout is known in exactly one place.
 */
function personDocsRoot(flagValue, db) {
  if (flagValue) return flagValue;
  if (insideContainer()) return process.env.PERSON_DOC_BASE || '/app/data/person-documents';
  if (process.env.WREN_PERSON_DOCS_ROOT) return process.env.WREN_PERSON_DOCS_ROOT;
  return path.join(path.dirname(uploadsRoot(null, db)), 'person-documents');
}

module.exports = { configure, archiveRoot, uploadsRoot, personDocsRoot, insideContainer };
