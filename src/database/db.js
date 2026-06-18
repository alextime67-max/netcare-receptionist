const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'netcare.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      call_sid          TEXT UNIQUE NOT NULL,
      patient_name      TEXT,
      patient_phone     TEXT,
      caller_number     TEXT,
      call_type         TEXT DEFAULT 'unknown',
      language          TEXT DEFAULT 'en',
      status            TEXT DEFAULT 'in_progress',
      duration          INTEGER,
      emergency_detected INTEGER DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id    INTEGER NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('assistant','patient')),
      content    TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id               INTEGER NOT NULL,
      patient_name          TEXT NOT NULL,
      patient_phone         TEXT NOT NULL,
      preferred_date        TEXT,
      preferred_time        TEXT,
      reason                TEXT,
      status                TEXT DEFAULT 'pending',
      tebra_appointment_id  TEXT,
      tebra_patient_id      TEXT,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS doctor_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id         INTEGER NOT NULL,
      patient_name    TEXT NOT NULL,
      patient_phone   TEXT NOT NULL,
      message_content TEXT NOT NULL,
      urgency         TEXT DEFAULT 'routine' CHECK(urgency IN ('routine','urgent')),
      status          TEXT DEFAULT 'pending',
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_call_type  ON calls(call_type);
    CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id);
  `);

  console.log('[DB] Database initialized at', path.join(DATA_DIR, 'netcare.db'));
}

// ── Calls ────────────────────────────────────────────────────────────────────

function createCall(callSid, callerNumber) {
  const result = db
    .prepare('INSERT INTO calls (call_sid, caller_number) VALUES (?, ?)')
    .run(callSid, callerNumber);
  return result.lastInsertRowid;
}

function updateCall(callSid, data) {
  const allowed = [
    'patient_name', 'patient_phone', 'call_type', 'language',
    'status', 'duration', 'emergency_detected',
  ];
  const filtered = Object.fromEntries(
    Object.entries(data).filter(([k]) => allowed.includes(k) && data[k] !== undefined)
  );
  if (!Object.keys(filtered).length) return;

  const sets = Object.keys(filtered).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE calls SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE call_sid = ?`)
    .run(...Object.values(filtered), callSid);
}

function getCallByCallSid(callSid) {
  return db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid);
}

function getCalls(limit = 100, offset = 0, filter = {}) {
  const conditions = [];
  const params = [];

  if (filter.callType)  { conditions.push('call_type = ?');      params.push(filter.callType); }
  if (filter.startDate) { conditions.push('created_at >= ?');    params.push(filter.startDate); }
  if (filter.endDate)   { conditions.push('created_at <= ?');    params.push(filter.endDate + 'T23:59:59'); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  return db.prepare(`SELECT * FROM calls ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params);
}

function getCallWithTranscript(callId) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call) return null;

  return {
    ...call,
    transcript:   db.prepare('SELECT role, content, created_at FROM transcripts WHERE call_id = ? ORDER BY created_at ASC').all(callId),
    appointment:  db.prepare('SELECT * FROM appointments WHERE call_id = ?').get(callId) || null,
    doctorMessage:db.prepare('SELECT * FROM doctor_messages WHERE call_id = ?').get(callId) || null,
  };
}

// ── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    totalCalls:          db.prepare('SELECT COUNT(*) AS n FROM calls').get().n,
    callsToday:          db.prepare("SELECT COUNT(*) AS n FROM calls WHERE date(created_at) = ?").get(today).n,
    appointmentsTotal:   db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n,
    appointmentsToday:   db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date(created_at) = ?").get(today).n,
    pendingAppointments: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'pending'").get().n,
    messagesTotal:       db.prepare('SELECT COUNT(*) AS n FROM doctor_messages').get().n,
    urgentMessages:      db.prepare("SELECT COUNT(*) AS n FROM doctor_messages WHERE urgency = 'urgent' AND status = 'pending'").get().n,
    spanishCalls:        db.prepare("SELECT COUNT(*) AS n FROM calls WHERE language = 'es'").get().n,
  };
}

// ── Appointments ─────────────────────────────────────────────────────────────

function createAppointment(callId, data) {
  return db.prepare(`
    INSERT INTO appointments (call_id, patient_name, patient_phone, preferred_date, preferred_time, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(callId, data.name, data.phone, data.appointmentDate, data.appointmentTime, data.reason)
    .lastInsertRowid;
}

function getAppointments(limit = 50) {
  return db.prepare(`
    SELECT a.*, c.call_sid, c.language, c.created_at AS call_date
    FROM appointments a
    JOIN calls c ON a.call_id = c.id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
}

function updateAppointmentStatus(id, status, tebraAppointmentId, tebraPatientId) {
  db.prepare(`
    UPDATE appointments
    SET status = ?, tebra_appointment_id = ?, tebra_patient_id = ?
    WHERE id = ?
  `).run(status, tebraAppointmentId || null, tebraPatientId || null, id);
}

// ── Doctor Messages ───────────────────────────────────────────────────────────

function createDoctorMessage(callId, data) {
  return db.prepare(`
    INSERT INTO doctor_messages (call_id, patient_name, patient_phone, message_content, urgency)
    VALUES (?, ?, ?, ?, ?)
  `).run(callId, data.name, data.phone, data.messageContent, data.urgency || 'routine')
    .lastInsertRowid;
}

function getDoctorMessages(limit = 50) {
  return db.prepare(`
    SELECT m.*, c.call_sid, c.language
    FROM doctor_messages m
    JOIN calls c ON m.call_id = c.id
    ORDER BY m.urgency DESC, m.created_at DESC
    LIMIT ?
  `).all(limit);
}

// ── Transcripts ───────────────────────────────────────────────────────────────

function addTranscript(callId, role, content) {
  db.prepare('INSERT INTO transcripts (call_id, role, content) VALUES (?, ?, ?)').run(callId, role, content);
}

module.exports = {
  db,
  initDb,
  createCall,
  updateCall,
  getCallByCallSid,
  getCalls,
  getCallWithTranscript,
  getStats,
  createAppointment,
  getAppointments,
  updateAppointmentStatus,
  createDoctorMessage,
  getDoctorMessages,
  addTranscript,
};
