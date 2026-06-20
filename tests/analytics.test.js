/**
 * Tests for analytics DB functions (Phase 7)
 * Uses Node's built-in test runner: node --test
 */
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Database = require('better-sqlite3');

// ── Build an in-memory DB with the same schema ────────────────────────────────

function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE clinics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE calls (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id         INTEGER DEFAULT 1,
      call_sid          TEXT UNIQUE NOT NULL,
      call_type         TEXT DEFAULT 'unknown',
      language          TEXT DEFAULT 'en',
      status            TEXT DEFAULT 'in_progress',
      duration          INTEGER,
      emergency_detected INTEGER DEFAULT 0,
      recording_url     TEXT,
      voicemail_left    INTEGER DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.prepare("INSERT INTO clinics (slug, name) VALUES ('test', 'Test Clinic')").run();
  return db;
}

// ── Inline analytics functions (replicated for testing) ──────────────────────

function getCallVolumeByDay(db, clinicId, days = 30) {
  const params = [];
  const where  = clinicId ? 'WHERE clinic_id = ? AND ' : 'WHERE ';
  if (clinicId) params.push(clinicId);
  return db.prepare(`
    SELECT date(created_at) AS date,
           COUNT(*) AS total,
           SUM(CASE WHEN status='completed'   THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status='abandoned'   THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN status='voicemail'   THEN 1 ELSE 0 END) AS voicemail,
           SUM(CASE WHEN status='transferred' THEN 1 ELSE 0 END) AS transferred,
           SUM(CASE WHEN status='emergency'   THEN 1 ELSE 0 END) AS emergency
    FROM calls
    ${where}created_at >= date('now', '-${Math.max(1, Math.min(90, days))} days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(...params);
}

function getCallAnalyticsSummary(db, clinicId) {
  const where  = clinicId ? 'WHERE clinic_id = ?' : '';
  const params = clinicId ? [clinicId] : [];

  const intentRows = db.prepare(
    `SELECT call_type, COUNT(*) AS count FROM calls ${where} GROUP BY call_type`
  ).all(...params);

  const langRows = db.prepare(
    `SELECT language, COUNT(*) AS count FROM calls ${where} GROUP BY language`
  ).all(...params);

  const durRow = db.prepare(
    `SELECT ROUND(AVG(duration)) AS avg FROM calls ${where ? where + ' AND' : 'WHERE'} duration IS NOT NULL AND duration > 0`
  ).get(...params);

  const totRow = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='completed'   THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status='voicemail'   THEN 1 ELSE 0 END) AS voicemail,
            SUM(CASE WHEN emergency_detected=1 THEN 1 ELSE 0 END) AS emergencies,
            SUM(CASE WHEN voicemail_left=1     THEN 1 ELSE 0 END) AS voicemails_left
     FROM calls ${where}`
  ).get(...params);

  return {
    intentBreakdown: Object.fromEntries(intentRows.map(r => [r.call_type || 'unknown', r.count])),
    languageSplit:   Object.fromEntries(langRows.map(r => [r.language || 'en', r.count])),
    avgDurationSecs: durRow?.avg || 0,
    totalCalls:      totRow?.total || 0,
    completedCalls:  totRow?.completed || 0,
    voicemailCalls:  totRow?.voicemail || 0,
    emergencies:     totRow?.emergencies || 0,
    voicemailsLeft:  totRow?.voicemails_left || 0,
    completionRate:  totRow?.total > 0 ? Math.round((totRow.completed / totRow.total) * 100) : 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('getCallVolumeByDay returns empty array when no calls', () => {
  const db   = buildTestDb();
  const rows = getCallVolumeByDay(db, 1, 30);
  assert.equal(rows.length, 0);
  db.close();
});

test('getCallVolumeByDay counts calls per day', () => {
  const db = buildTestDb();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, status) VALUES (1,'CA1','completed')").run();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, status) VALUES (1,'CA2','abandoned')").run();
  const rows = getCallVolumeByDay(db, 1, 30);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].completed, 1);
  assert.equal(rows[0].abandoned, 1);
  db.close();
});

test('getCallAnalyticsSummary totals across clinic', () => {
  const db = buildTestDb();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, call_type, language, status, duration) VALUES (1,'CB1','appointment','en','completed',120)").run();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, call_type, language, status, duration) VALUES (1,'CB2','message','es','completed',60)").run();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, call_type, language, status) VALUES (1,'CB3','unknown','en','abandoned')").run();

  const s = getCallAnalyticsSummary(db, 1);
  assert.equal(s.totalCalls,     3);
  assert.equal(s.completedCalls, 2);
  assert.equal(s.completionRate, 67);
  assert.equal(s.intentBreakdown.appointment, 1);
  assert.equal(s.intentBreakdown.message,     1);
  assert.equal(s.languageSplit.en, 2);
  assert.equal(s.languageSplit.es, 1);
  assert.ok(s.avgDurationSecs > 0);
  db.close();
});

test('getCallAnalyticsSummary handles voicemail calls', () => {
  const db = buildTestDb();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, status, voicemail_left) VALUES (1,'CV1','voicemail',1)").run();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, status, voicemail_left) VALUES (1,'CV2','completed',0)").run();

  const s = getCallAnalyticsSummary(db, 1);
  assert.equal(s.voicemailsLeft, 1);
  assert.equal(s.totalCalls, 2);
  db.close();
});

test('getCallAnalyticsSummary completion rate is 0 for empty clinic', () => {
  const db = buildTestDb();
  const s  = getCallAnalyticsSummary(db, 1);
  assert.equal(s.completionRate, 0);
  assert.equal(s.totalCalls,     0);
  db.close();
});

test('getCallVolumeByDay filters by clinicId', () => {
  const db = buildTestDb();
  db.prepare("INSERT INTO clinics (slug, name) VALUES ('clinic2', 'Clinic 2')").run();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, status) VALUES (1,'CD1','completed')").run();
  db.prepare("INSERT INTO calls (clinic_id, call_sid, status) VALUES (2,'CD2','completed')").run();

  const clinic1 = getCallVolumeByDay(db, 1, 30);
  const clinic2 = getCallVolumeByDay(db, 2, 30);
  assert.equal(clinic1[0]?.total, 1);
  assert.equal(clinic2[0]?.total, 1);
  db.close();
});
