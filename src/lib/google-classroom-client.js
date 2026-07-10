'use strict';
// google-classroom-client.js
// Read-only wrapper around the Google Classroom API using domain-wide delegation.
//
// Prerequisites:
//   1. Service account: <your-service-account>@<your-project>.iam.gserviceaccount.com
//   2. Domain-wide delegation enabled on the service account in Google Workspace Admin
//   3. Classroom API scopes granted in Workspace Admin > Security > API Controls
//   4. Key JSON stored at GOOGLE_SA_KEY_PATH (or inline as GOOGLE_SA_KEY_JSON)
//
// The client impersonates a Workspace admin (adminEmail) so it can list all
// courses and rosters in the school's domain.  We never write anything.

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
  'https://www.googleapis.com/auth/classroom.profile.emails',
];

function loadKey() {
  const keyJson = process.env.GOOGLE_SA_KEY_JSON;
  if (keyJson) {
    try { return JSON.parse(keyJson); } catch { throw new Error('GOOGLE_SA_KEY_JSON is not valid JSON'); }
  }
  const keyPath = process.env.GOOGLE_SA_KEY_PATH;
  if (!keyPath) throw new Error('GOOGLE_SA_KEY_PATH or GOOGLE_SA_KEY_JSON must be set');
  const fs = require('fs');
  if (!fs.existsSync(keyPath)) throw new Error(`Service account key file not found: ${keyPath}`);
  return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
}

function createAuth(adminEmail) {
  const key = loadKey();
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: adminEmail,
  });
}

async function getClient(adminEmail) {
  const auth = createAuth(adminEmail);
  await auth.authorize();
  return google.classroom({ version: 'v1', auth });
}

async function paginate(fn, pageTokenField = 'nextPageToken') {
  const items = [];
  let pageToken;
  do {
    const result = await fn(pageToken);
    const data = result.data;
    const keys = Object.keys(data).filter(k => k !== pageTokenField && Array.isArray(data[k]));
    if (keys.length) items.push(...(data[keys[0]] || []));
    pageToken = data[pageTokenField];
  } while (pageToken);
  return items;
}

async function listCourses(adminEmail) {
  const client = await getClient(adminEmail);
  return paginate(pt => client.courses.list({
    pageSize: 100,
    courseStates: ['ACTIVE'],
    pageToken: pt,
  }));
}

async function listCoursework(adminEmail, courseId) {
  const client = await getClient(adminEmail);
  return paginate(pt => client.courses.courseWork.list({
    courseId,
    pageSize: 100,
    pageToken: pt,
  }));
}

async function listStudents(adminEmail, courseId) {
  const client = await getClient(adminEmail);
  return paginate(pt => client.courses.students.list({
    courseId,
    pageSize: 200,
    pageToken: pt,
  }));
}

async function listSubmissions(adminEmail, courseId, courseworkId) {
  const client = await getClient(adminEmail);
  return paginate(pt => client.courses.courseWork.studentSubmissions.list({
    courseId,
    courseWorkId: courseworkId,
    pageSize: 200,
    pageToken: pt,
  }));
}

async function testConnection(adminEmail) {
  const courses = await listCourses(adminEmail);
  return { ok: true, courseCount: courses.length, courses: courses.slice(0, 5).map(c => c.name) };
}

module.exports = { listCourses, listCoursework, listStudents, listSubmissions, testConnection, SCOPES };
