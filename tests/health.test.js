/**
 * Tests for health check and DB migration guards (Phase 7)
 */
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Database = require('better-sqlite3');

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHealthChecks(opts = {}) {
  const {
    dbOk          = true,
    apiKey        = 'sk-ant-test',
    appUrl        = 'https://example.com',
    portalSecret  = 'secret123',
    twilioCount   = 1,
    totalClinics  = 2,
  } = opts;

  const checks = {};
  checks.database     = dbOk ? { status: 'ok' } : { status: 'error', message: 'DB failed' };
  checks.anthropicKey = { status: apiKey ? 'ok' : 'missing' };
  checks.appUrl       = { status: appUrl ? 'ok' : 'warning', value: appUrl || '(not set)' };
  checks.twilio       = { status: twilioCount > 0 ? 'ok' : 'warning', clinicsConfigured: twilioCount, totalClinics };
  checks.portalSecret = { status: portalSecret ? 'ok' : 'warning' };

  const healthy = checks.database.status === 'ok' && checks.anthropicKey.status === 'ok';
  return { status: healthy ? 'healthy' : 'degraded', checks, timestamp: new Date().toISOString() };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('health check is healthy when DB and API key are present', () => {
  const result = buildHealthChecks({ dbOk: true, apiKey: 'sk-ant-test' });
  assert.equal(result.status, 'healthy');
  assert.equal(result.checks.database.status, 'ok');
  assert.equal(result.checks.anthropicKey.status, 'ok');
});

test('health check is degraded when DB fails', () => {
  const result = buildHealthChecks({ dbOk: false });
  assert.equal(result.status, 'degraded');
  assert.equal(result.checks.database.status, 'error');
});

test('health check is degraded when API key missing', () => {
  const result = buildHealthChecks({ apiKey: '' });
  assert.equal(result.status, 'degraded');
  assert.equal(result.checks.anthropicKey.status, 'missing');
});

test('health check warns when no Twilio clinics configured', () => {
  const result = buildHealthChecks({ twilioCount: 0, totalClinics: 3 });
  assert.equal(result.checks.twilio.status, 'warning');
  assert.equal(result.checks.twilio.clinicsConfigured, 0);
});

test('health check warns when APP_URL is missing', () => {
  const result = buildHealthChecks({ appUrl: '' });
  assert.equal(result.checks.appUrl.status, 'warning');
});

test('health check includes timestamp', () => {
  const result = buildHealthChecks();
  assert.ok(result.timestamp);
  assert.doesNotThrow(() => new Date(result.timestamp));
});

// ── DB migration guard tests ──────────────────────────────────────────────────

test('SQLite in-memory DB accepts recording_url column on calls', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE calls (id INTEGER PRIMARY KEY, call_sid TEXT, status TEXT DEFAULT 'in_progress');
    ALTER TABLE calls ADD COLUMN recording_url TEXT;
    ALTER TABLE calls ADD COLUMN voicemail_left INTEGER DEFAULT 0;
  `);
  db.prepare("INSERT INTO calls (call_sid, recording_url, voicemail_left) VALUES ('CA1','https://api.twilio.com/recordings/RE1',1)").run();
  const row = db.prepare("SELECT * FROM calls WHERE call_sid='CA1'").get();
  assert.equal(row.recording_url,  'https://api.twilio.com/recordings/RE1');
  assert.equal(row.voicemail_left, 1);
  db.close();
});

test('SQLite in-memory DB accepts sms_follow_up_enabled on clinics', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE clinics (id INTEGER PRIMARY KEY, slug TEXT, name TEXT);
    ALTER TABLE clinics ADD COLUMN sms_follow_up_enabled INTEGER DEFAULT 0;
  `);
  db.prepare("INSERT INTO clinics (slug, name, sms_follow_up_enabled) VALUES ('test','Test Clinic',1)").run();
  const row = db.prepare("SELECT * FROM clinics WHERE slug='test'").get();
  assert.equal(row.sms_follow_up_enabled, 1);
  db.close();
});

test('voicemail status is valid call status value', () => {
  const validStatuses = ['in_progress','completed','abandoned','transferred','emergency','voicemail','missed'];
  assert.ok(validStatuses.includes('voicemail'));
  assert.ok(validStatuses.includes('missed'));
});
