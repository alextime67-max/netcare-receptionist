const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'netcare.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  // ── Core tables (no indexes yet — migrations run first) ───────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS clinics (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slug             TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      phone_display    TEXT,
      twilio_sid       TEXT,
      twilio_token     TEXT,
      twilio_phone     TEXT,
      twilio_validate  INTEGER DEFAULT 0,
      admin_user       TEXT DEFAULT 'admin',
      admin_pass       TEXT DEFAULT 'NetCare2024!',
      clinic_email     TEXT,
      email_from       TEXT,
      gmail_user       TEXT,
      gmail_app_pass   TEXT,
      smtp_host        TEXT,
      smtp_port        TEXT,
      smtp_secure      INTEGER DEFAULT 0,
      smtp_user        TEXT,
      smtp_pass        TEXT,
      active           INTEGER DEFAULT 1,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
      call_id               INTEGER,
      patient_name          TEXT NOT NULL,
      patient_phone         TEXT NOT NULL,
      preferred_date        TEXT,
      preferred_time        TEXT,
      reason                TEXT,
      status                TEXT DEFAULT 'pending',
      tebra_appointment_id  TEXT,
      tebra_patient_id      TEXT,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS doctor_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id         INTEGER,
      patient_name    TEXT NOT NULL,
      patient_phone   TEXT NOT NULL,
      message_content TEXT NOT NULL,
      urgency         TEXT DEFAULT 'routine' CHECK(urgency IN ('routine','urgent')),
      status          TEXT DEFAULT 'pending',
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS web_requests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name     TEXT NOT NULL,
      last_name      TEXT NOT NULL,
      phone          TEXT NOT NULL,
      email          TEXT,
      date_of_birth  TEXT,
      preferred_date TEXT,
      preferred_time TEXT,
      reason         TEXT,
      language       TEXT DEFAULT 'en',
      status         TEXT DEFAULT 'pending',
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Migrations: add clinic_id to all data tables ──────────────────────────

  _addColumnIfMissing('calls',           'clinic_id', 'INTEGER DEFAULT 1');
  _addColumnIfMissing('appointments',    'clinic_id', 'INTEGER DEFAULT 1');
  _addColumnIfMissing('appointments',    'call_id',   'INTEGER');
  _addColumnIfMissing('doctor_messages', 'clinic_id', 'INTEGER DEFAULT 1');
  _addColumnIfMissing('doctor_messages', 'call_id',   'INTEGER');
  _addColumnIfMissing('web_requests',    'clinic_id', 'INTEGER DEFAULT 1');

  // ── Migrations: Phase 4 AI config fields on clinics ─────────────────────────

  _addColumnIfMissing('clinics', 'ai_assistant_name',          'TEXT');
  _addColumnIfMissing('clinics', 'ai_greeting_en',             'TEXT');
  _addColumnIfMissing('clinics', 'ai_greeting_es',             'TEXT');
  _addColumnIfMissing('clinics', 'ai_business_description',    'TEXT');
  _addColumnIfMissing('clinics', 'ai_services',                'TEXT');
  _addColumnIfMissing('clinics', 'ai_faq',                     'TEXT');
  _addColumnIfMissing('clinics', 'ai_appointment_instructions','TEXT');
  _addColumnIfMissing('clinics', 'ai_transfer_rules',          'TEXT');
  _addColumnIfMissing('clinics', 'ai_office_hours',            'TEXT');
  _addColumnIfMissing('clinics', 'ai_after_hours_message',     'TEXT');
  _addColumnIfMissing('clinics', 'ai_emergency_instructions',  'TEXT');
  _addColumnIfMissing('clinics', 'ai_industry_template',       'TEXT');
  _addColumnIfMissing('clinics', 'ai_master_prompt',           'TEXT');
  _addColumnIfMissing('clinics', 'transfer_phone',             'TEXT');

  // ── Migrations: Phase 2 CRM fields on clinics ─────────────────────────────

  _addColumnIfMissing('clinics', 'account_number',  'TEXT');
  _addColumnIfMissing('clinics', 'contact_person',  'TEXT');
  _addColumnIfMissing('clinics', 'contact_phone',   'TEXT');
  _addColumnIfMissing('clinics', 'contact_email',   'TEXT');
  _addColumnIfMissing('clinics', 'business_type',   'TEXT DEFAULT \'Medical\'');
  _addColumnIfMissing('clinics', 'monthly_plan',    'TEXT DEFAULT \'Starter\'');
  _addColumnIfMissing('clinics', 'monthly_price',   'REAL DEFAULT 0');
  _addColumnIfMissing('clinics', 'payment_status',  'TEXT DEFAULT \'trial\'');
  _addColumnIfMissing('clinics', 'status',          'TEXT DEFAULT \'active\'');
  _addColumnIfMissing('clinics', 'support_notes',   'TEXT');
  _addColumnIfMissing('clinics', 'onboarded_at',    'DATETIME');
  _addColumnIfMissing('clinics', 'suspended_at',    'DATETIME');

  // ── Migrations: Phase 7 SMS + voicemail ──────────────────────────────────

  _addColumnIfMissing('clinics', 'sms_follow_up_enabled', 'INTEGER DEFAULT 0');
  _addColumnIfMissing('calls',   'recording_url',          'TEXT');
  _addColumnIfMissing('calls',   'voicemail_left',         'INTEGER DEFAULT 0');

  // ── Migrations: IVR DTMF menu ─────────────────────────────────────────────

  _addColumnIfMissing('clinics', 'ivr_enabled', 'INTEGER DEFAULT 0');
  _addColumnIfMissing('clinics', 'ivr_config',  'TEXT');

  // Back-fill account numbers for any clinic that doesn't have one yet
  const noAcct = db.prepare("SELECT id FROM clinics WHERE account_number IS NULL OR account_number = ''").all();
  for (const row of noAcct) {
    db.prepare("UPDATE clinics SET account_number = ? WHERE id = ?")
      .run(_nextAccountNumber(), row.id);
  }

  // ── Indexes (safe now that columns exist) ─────────────────────────────────

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_calls_clinic       ON calls(clinic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_created_at   ON calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_call_type    ON calls(call_type);
    CREATE INDEX IF NOT EXISTS idx_transcripts_call   ON transcripts(call_id);
    CREATE INDEX IF NOT EXISTS idx_appts_clinic       ON appointments(clinic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_msgs_clinic        ON doctor_messages(clinic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_webreq_clinic      ON web_requests(clinic_id, created_at DESC);
  `);

  // ── Seed default clinic from env vars if none exist ───────────────────────

  const count = db.prepare('SELECT COUNT(*) AS n FROM clinics').get().n;
  if (count === 0) {
    db.prepare(`
      INSERT INTO clinics
        (slug, name, twilio_sid, twilio_token, twilio_phone, twilio_validate,
         admin_user, admin_pass, clinic_email, email_from,
         gmail_user, gmail_app_pass,
         smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'netcare',
      process.env.CLINIC_NAME    || 'NetCare Clinic',
      process.env.TWILIO_ACCOUNT_SID  || null,
      process.env.TWILIO_AUTH_TOKEN   || null,
      process.env.TWILIO_PHONE_NUMBER || null,
      process.env.TWILIO_VALIDATE === 'true' ? 1 : 0,
      process.env.ADMIN_USER     || 'admin',
      process.env.ADMIN_PASS     || 'NetCare2024!',
      process.env.CLINIC_EMAIL   || null,
      process.env.EMAIL_FROM     || null,
      process.env.GMAIL_USER         || null,
      process.env.GMAIL_APP_PASSWORD || null,
      process.env.SMTP_HOST      || null,
      process.env.SMTP_PORT      || null,
      process.env.SMTP_SECURE === 'true' ? 1 : 0,
      process.env.SMTP_USER      || null,
      process.env.SMTP_PASS      || null,
    );
    console.log('[DB] Seeded default clinic "netcare" from environment variables.');
  }

  // ── Seed MDcare clinic with IVR config ───────────────────────────────────

  const mdcareExists = db.prepare("SELECT id FROM clinics WHERE slug = 'mdcare'").get();
  if (!mdcareExists) {
    const mdcareIvr = JSON.stringify({
      clinicDisplayName: 'MDcare',
      greeting:          'Thank you for calling MDcare.',
      options: [
        { digit: '1', label: 'Hialeah Medical Center'    },
        { digit: '2', label: 'Homestead Medical Center'   },
        { digit: '3', label: 'Coral Gables Medical Center' },
      ],
      repeatDigit: '9',
      voice:       'Polly.Joanna',
      language:    'en-US',
    });
    db.prepare(`
      INSERT INTO clinics (slug, name, ivr_enabled, ivr_config, admin_user, admin_pass, status)
      VALUES ('mdcare', 'MDcare', 1, ?, 'admin', 'MDcare2024!', 'active')
    `).run(mdcareIvr);
    console.log('[DB] Seeded MDcare clinic with IVR configuration.');
  }

  console.log('[DB] Database initialized at', path.join(DATA_DIR, 'netcare.db'));
}

function _addColumnIfMissing(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    console.log(`[DB] Migration: added ${table}.${column}`);
  }
}

function _nextAccountNumber() {
  const row = db.prepare("SELECT account_number FROM clinics WHERE account_number LIKE 'NC-%' ORDER BY id DESC LIMIT 1").get();
  const last = row ? parseInt(row.account_number.replace('NC-', ''), 10) : 0;
  return `NC-${String(last + 1).padStart(4, '0')}`;
}

// ── Clinics ───────────────────────────────────────────────────────────────────

function createClinic(data) {
  const acctNum = _nextAccountNumber();
  return db.prepare(`
    INSERT INTO clinics
      (slug, name, account_number, phone_display,
       contact_person, contact_phone, contact_email,
       business_type, monthly_plan, monthly_price, payment_status, status,
       support_notes, onboarded_at,
       twilio_sid, twilio_token, twilio_phone, twilio_validate,
       admin_user, admin_pass, clinic_email, email_from,
       gmail_user, gmail_app_pass, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    data.slug, data.name, acctNum, data.phoneDisplay || null,
    data.contactPerson || null, data.contactPhone || null, data.contactEmail || null,
    data.businessType || 'Medical',
    data.monthlyPlan  || 'Starter',
    data.monthlyPrice != null ? +data.monthlyPrice : 0,
    data.paymentStatus || 'trial',
    data.status || 'active',
    data.supportNotes || null,
    data.status === 'active' ? new Date().toISOString() : null,
    data.twilioSid || null, data.twilioToken || null, data.twilioPhone || null,
    data.twilioValidate ? 1 : 0,
    data.adminUser || 'admin', data.adminPass || 'NetCare2024!',
    data.clinicEmail || null, data.emailFrom || null,
    data.gmailUser || null, data.gmailAppPass || null,
    data.smtpHost || null, data.smtpPort || null,
    data.smtpSecure ? 1 : 0, data.smtpUser || null, data.smtpPass || null,
  ).lastInsertRowid;
}

function getClinics() {
  return db.prepare('SELECT * FROM clinics ORDER BY created_at ASC').all();
}

function getClinicBySlug(slug) {
  return db.prepare('SELECT * FROM clinics WHERE slug = ?').get(slug);
}

function getClinicById(id) {
  return db.prepare('SELECT * FROM clinics WHERE id = ?').get(id);
}

function updateClinic(id, data) {
  const allowed = [
    'name', 'phone_display',
    'contact_person', 'contact_phone', 'contact_email',
    'business_type', 'monthly_plan', 'monthly_price', 'payment_status',
    'status', 'support_notes', 'onboarded_at', 'suspended_at',
    'twilio_sid', 'twilio_token', 'twilio_phone', 'twilio_validate',
    'admin_user', 'admin_pass', 'clinic_email', 'email_from',
    'gmail_user', 'gmail_app_pass', 'smtp_host', 'smtp_port', 'smtp_secure',
    'smtp_user', 'smtp_pass', 'active', 'sms_follow_up_enabled',
    'ivr_enabled', 'ivr_config',
  ];
  const map = {
    name: data.name, phone_display: data.phoneDisplay,
    contact_person: data.contactPerson, contact_phone: data.contactPhone,
    contact_email: data.contactEmail,
    business_type: data.businessType, monthly_plan: data.monthlyPlan,
    monthly_price: data.monthlyPrice != null ? +data.monthlyPrice : undefined,
    payment_status: data.paymentStatus, status: data.status,
    support_notes: data.supportNotes,
    onboarded_at: data.onboardedAt, suspended_at: data.suspendedAt,
    twilio_sid: data.twilioSid, twilio_token: data.twilioToken,
    twilio_phone: data.twilioPhone,
    twilio_validate: data.twilioValidate !== undefined ? (data.twilioValidate ? 1 : 0) : undefined,
    admin_user: data.adminUser, admin_pass: data.adminPass,
    clinic_email: data.clinicEmail, email_from: data.emailFrom,
    gmail_user: data.gmailUser, gmail_app_pass: data.gmailAppPass,
    smtp_host: data.smtpHost, smtp_port: data.smtpPort,
    smtp_secure: data.smtpSecure !== undefined ? (data.smtpSecure ? 1 : 0) : undefined,
    smtp_user: data.smtpUser, smtp_pass: data.smtpPass,
    active: data.active !== undefined ? (data.active ? 1 : 0) : undefined,
    sms_follow_up_enabled: data.smsFollowUpEnabled !== undefined ? (data.smsFollowUpEnabled ? 1 : 0) : undefined,
    ivr_enabled: data.ivrEnabled !== undefined ? (data.ivrEnabled ? 1 : 0) : undefined,
    ivr_config:  data.ivrConfig  !== undefined ? data.ivrConfig  : undefined,
  };
  const filtered = Object.fromEntries(
    allowed.filter(k => map[k] !== undefined).map(k => [k, map[k]])
  );
  if (!Object.keys(filtered).length) return;
  const sets = Object.keys(filtered).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE clinics SET ${sets} WHERE id = ?`)
    .run(...Object.values(filtered), id);
}

function deleteClinic(id) {
  db.prepare('DELETE FROM clinics WHERE id = ?').run(id);
}

// ── Calls ─────────────────────────────────────────────────────────────────────

function createCall(callSid, callerNumber, clinicId) {
  return db
    .prepare('INSERT INTO calls (call_sid, caller_number, clinic_id) VALUES (?, ?, ?)')
    .run(callSid, callerNumber, clinicId)
    .lastInsertRowid;
}

function updateCall(callSid, data) {
  const allowed = [
    'patient_name', 'patient_phone', 'call_type', 'language',
    'status', 'duration', 'emergency_detected', 'recording_url', 'voicemail_left',
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

  if (filter.clinicId)  { conditions.push('clinic_id = ?');    params.push(filter.clinicId); }
  if (filter.callType)  { conditions.push('call_type = ?');    params.push(filter.callType); }
  if (filter.startDate) { conditions.push('created_at >= ?');  params.push(filter.startDate); }
  if (filter.endDate)   { conditions.push('created_at <= ?');  params.push(filter.endDate + 'T23:59:59'); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  return db.prepare(`SELECT * FROM calls ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params);
}

function getAllCalls(limit = 100, offset = 0, filter = {}) {
  const conditions = [];
  const params = [];
  if (filter.clinicId)  { conditions.push('calls.clinic_id = ?'); params.push(filter.clinicId); }
  if (filter.status)    { conditions.push('calls.status = ?');    params.push(filter.status); }
  if (filter.startDate) { conditions.push('calls.created_at >= ?'); params.push(filter.startDate); }
  if (filter.endDate)   { conditions.push('calls.created_at <= ?'); params.push(filter.endDate + 'T23:59:59'); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  return db.prepare(`
    SELECT calls.*, clinics.name AS clinic_name, clinics.slug AS clinic_slug
    FROM calls
    INNER JOIN clinics ON calls.clinic_id = clinics.id
    ${where}
    ORDER BY calls.created_at DESC LIMIT ? OFFSET ?
  `).all(...params);
}

function getCallCount(filter = {}) {
  const conditions = [];
  const params = [];
  if (filter.clinicId)  { conditions.push('calls.clinic_id = ?'); params.push(filter.clinicId); }
  if (filter.status)    { conditions.push('calls.status = ?');    params.push(filter.status); }
  if (filter.startDate) { conditions.push('calls.created_at >= ?'); params.push(filter.startDate); }
  if (filter.endDate)   { conditions.push('calls.created_at <= ?'); params.push(filter.endDate + 'T23:59:59'); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT COUNT(*) AS n FROM calls
    INNER JOIN clinics ON calls.clinic_id = clinics.id
    ${where}
  `).get(...params).n;
}

function getCallWithTranscript(callId) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call) return null;
  return {
    ...call,
    transcript:    db.prepare('SELECT role, content, created_at FROM transcripts WHERE call_id = ? ORDER BY created_at ASC').all(callId),
    appointment:   db.prepare('SELECT * FROM appointments WHERE call_id = ?').get(callId) || null,
    doctorMessage: db.prepare('SELECT * FROM doctor_messages WHERE call_id = ?').get(callId) || null,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function getStats(clinicId) {
  const today = new Date().toISOString().slice(0, 10);
  const cid = clinicId;
  const q  = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    totalCalls:          q('SELECT COUNT(*) AS n FROM calls WHERE clinic_id=?', cid),
    callsToday:          q('SELECT COUNT(*) AS n FROM calls WHERE clinic_id=? AND date(created_at)=?', cid, today),
    appointmentsTotal:   q('SELECT COUNT(*) AS n FROM appointments WHERE clinic_id=?', cid),
    appointmentsToday:   q('SELECT COUNT(*) AS n FROM appointments WHERE clinic_id=? AND date(created_at)=?', cid, today),
    pendingAppointments: q("SELECT COUNT(*) AS n FROM appointments WHERE clinic_id=? AND status='pending'", cid),
    messagesTotal:       q('SELECT COUNT(*) AS n FROM doctor_messages WHERE clinic_id=?', cid),
    urgentMessages:      q("SELECT COUNT(*) AS n FROM doctor_messages WHERE clinic_id=? AND urgency='urgent' AND status='pending'", cid),
    spanishCalls:        q("SELECT COUNT(*) AS n FROM calls WHERE clinic_id=? AND language='es'", cid),
    webRequestsTotal:    q('SELECT COUNT(*) AS n FROM web_requests WHERE clinic_id=?', cid),
    webRequestsToday:    q('SELECT COUNT(*) AS n FROM web_requests WHERE clinic_id=? AND date(created_at)=?', cid, today),
    pendingWebRequests:  q("SELECT COUNT(*) AS n FROM web_requests WHERE clinic_id=? AND status='pending'", cid),
  };
}

function getGlobalStats() {
  const q = (sql) => db.prepare(sql).get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(monthly_price),0) AS n FROM clinics WHERE status='active'").get().n;
  return {
    totalClients:     q('SELECT COUNT(*) AS n FROM clinics'),
    activeClients:    q("SELECT COUNT(*) AS n FROM clinics WHERE status='active'"),
    suspendedClients: q("SELECT COUNT(*) AS n FROM clinics WHERE status='suspended'"),
    cancelledClients: q("SELECT COUNT(*) AS n FROM clinics WHERE status='cancelled'"),
    monthlyRevenue:   revenue,
    totalCalls:       q('SELECT COUNT(*) AS n FROM calls'),
    totalAppointments:q('SELECT COUNT(*) AS n FROM appointments'),
    totalMessages:    q('SELECT COUNT(*) AS n FROM doctor_messages'),
    totalWebRequests: q('SELECT COUNT(*) AS n FROM web_requests'),
  };
}

// ── Appointments ──────────────────────────────────────────────────────────────

function createAppointment(callId, data, clinicId) {
  return db.prepare(`
    INSERT INTO appointments (clinic_id, call_id, patient_name, patient_phone, preferred_date, preferred_time, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(clinicId, callId, data.name, data.phone, data.appointmentDate, data.appointmentTime, data.reason)
    .lastInsertRowid;
}

function getAppointments(limit = 50, clinicId) {
  return db.prepare(`
    SELECT a.*, c.call_sid, c.language, c.created_at AS call_date
    FROM appointments a
    LEFT JOIN calls c ON a.call_id = c.id
    WHERE a.clinic_id = ?
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(clinicId, limit);
}

function updateAppointmentStatus(id, status, tebraAppointmentId, tebraPatientId) {
  db.prepare(`
    UPDATE appointments
    SET status = ?, tebra_appointment_id = ?, tebra_patient_id = ?
    WHERE id = ?
  `).run(status, tebraAppointmentId || null, tebraPatientId || null, id);
}

// ── Doctor Messages ───────────────────────────────────────────────────────────

function createDoctorMessage(callId, data, clinicId) {
  return db.prepare(`
    INSERT INTO doctor_messages (clinic_id, call_id, patient_name, patient_phone, message_content, urgency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(clinicId, callId, data.name, data.phone, data.messageContent, data.urgency || 'routine')
    .lastInsertRowid;
}

function getDoctorMessages(limit = 50, clinicId) {
  return db.prepare(`
    SELECT m.*, c.call_sid, c.language
    FROM doctor_messages m
    LEFT JOIN calls c ON m.call_id = c.id
    WHERE m.clinic_id = ?
    ORDER BY m.urgency DESC, m.created_at DESC
    LIMIT ?
  `).all(clinicId, limit);
}

function updateDoctorMessageStatus(id, status) {
  db.prepare('UPDATE doctor_messages SET status = ? WHERE id = ?').run(status, id);
}

// ── Transcripts ───────────────────────────────────────────────────────────────

function addTranscript(callId, role, content) {
  db.prepare('INSERT INTO transcripts (call_id, role, content) VALUES (?, ?, ?)').run(callId, role, content);
}

// ── Web Requests ──────────────────────────────────────────────────────────────

function saveWebRequest(data, clinicId) {
  return db.prepare(`
    INSERT INTO web_requests (clinic_id, first_name, last_name, phone, email, date_of_birth, preferred_date, preferred_time, reason, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clinicId,
    data.firstName, data.lastName, data.phone, data.email || null,
    data.dateOfBirth || null, data.preferredDate || null,
    data.preferredTime || null, data.reason || null, data.language || 'en'
  ).lastInsertRowid;
}

function getWebRequests(limit = 50, clinicId) {
  return db.prepare('SELECT * FROM web_requests WHERE clinic_id = ? ORDER BY created_at DESC LIMIT ?').all(clinicId, limit);
}

function updateWebRequestStatus(id, status) {
  db.prepare('UPDATE web_requests SET status = ? WHERE id = ?').run(status, id);
}

// ── AI config helpers ─────────────────────────────────────────────────────────

function getClinicAiConfig(id) {
  return db.prepare(`
    SELECT id, name,
           ai_assistant_name, ai_greeting_en, ai_greeting_es,
           ai_business_description, ai_services, ai_faq,
           ai_appointment_instructions, ai_transfer_rules,
           ai_office_hours, ai_after_hours_message, ai_emergency_instructions,
           ai_industry_template, ai_master_prompt
    FROM clinics WHERE id = ?
  `).get(id);
}

function updateClinicAiConfig(id, data) {
  const allowed = [
    'ai_assistant_name', 'ai_greeting_en', 'ai_greeting_es',
    'ai_business_description', 'ai_services', 'ai_faq',
    'ai_appointment_instructions', 'ai_transfer_rules',
    'ai_office_hours', 'ai_after_hours_message', 'ai_emergency_instructions',
    'ai_industry_template', 'ai_master_prompt',
  ];
  const map = {
    ai_assistant_name:           data.assistantName,
    ai_greeting_en:              data.greetingEn,
    ai_greeting_es:              data.greetingEs,
    ai_business_description:     data.businessDescription,
    ai_services:                 data.services,
    ai_faq:                      data.faq,
    ai_appointment_instructions: data.appointmentInstructions,
    ai_transfer_rules:           data.transferRules,
    ai_office_hours:             data.officeHours,
    ai_after_hours_message:      data.afterHoursMessage,
    ai_emergency_instructions:   data.emergencyInstructions,
    ai_industry_template:        data.industryTemplate,
    ai_master_prompt:            data.masterPrompt,
  };
  const filtered = Object.fromEntries(
    allowed.filter(k => map[k] !== undefined).map(k => [k, map[k] ?? null])
  );
  if (!Object.keys(filtered).length) return;
  const sets = Object.keys(filtered).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE clinics SET ${sets} WHERE id = ?`).run(...Object.values(filtered), id);
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function getCallVolumeByDay(clinicId, days = 30) {
  const params = [];
  const where  = clinicId ? 'WHERE clinic_id = ? AND ' : 'WHERE ';
  if (clinicId) params.push(clinicId);
  return db.prepare(`
    SELECT date(created_at) AS date,
           COUNT(*) AS total,
           SUM(CASE WHEN status='completed'  THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status='abandoned'  THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN status='voicemail'  THEN 1 ELSE 0 END) AS voicemail,
           SUM(CASE WHEN status='transferred'THEN 1 ELSE 0 END) AS transferred,
           SUM(CASE WHEN status='emergency'  THEN 1 ELSE 0 END) AS emergency
    FROM calls
    ${where}created_at >= date('now', '-${Math.max(1, Math.min(90, days))} days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(...params);
}

function getCallAnalyticsSummary(clinicId) {
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
            SUM(CASE WHEN status='completed'     THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status='voicemail'     THEN 1 ELSE 0 END) AS voicemail,
            SUM(CASE WHEN emergency_detected=1   THEN 1 ELSE 0 END) AS emergencies,
            SUM(CASE WHEN voicemail_left=1       THEN 1 ELSE 0 END) AS voicemails_left
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

// ── Portal helpers ────────────────────────────────────────────────────────────

function updateClinicTwilio(id, data) {
  const allowed = ['twilio_sid', 'twilio_token', 'twilio_phone', 'twilio_validate'];
  const map = {
    twilio_sid:      data.twilioSid,
    twilio_token:    data.twilioToken,
    twilio_phone:    data.twilioPhone,
    twilio_validate: data.twilioValidate !== undefined ? (data.twilioValidate ? 1 : 0) : undefined,
  };
  const filtered = Object.fromEntries(
    allowed.filter(k => map[k] !== undefined).map(k => [k, map[k]])
  );
  if (!Object.keys(filtered).length) return;
  const sets = Object.keys(filtered).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE clinics SET ${sets} WHERE id = ?`).run(...Object.values(filtered), id);
}

function getClinicBilling(id) {
  return db.prepare(`
    SELECT id, slug, name, account_number, contact_person, contact_email, contact_phone,
           business_type, monthly_plan, monthly_price, payment_status, status,
           onboarded_at, suspended_at, created_at
    FROM clinics WHERE id = ?
  `).get(id);
}

module.exports = {
  db,
  initDb,
  // clinics
  createClinic,
  getClinics,
  getClinicBySlug,
  getClinicById,
  updateClinic,
  updateClinicTwilio,
  getClinicBilling,
  getClinicAiConfig,
  updateClinicAiConfig,
  deleteClinic,
  getGlobalStats,
  // calls
  createCall,
  updateCall,
  getCallByCallSid,
  getCalls,
  getAllCalls,
  getCallCount,
  getCallWithTranscript,
  getStats,
  // appointments
  createAppointment,
  getAppointments,
  updateAppointmentStatus,
  // messages
  createDoctorMessage,
  getDoctorMessages,
  updateDoctorMessageStatus,
  // transcripts
  addTranscript,
  // web requests
  saveWebRequest,
  getWebRequests,
  updateWebRequestStatus,
  // analytics
  getCallVolumeByDay,
  getCallAnalyticsSummary,
};
