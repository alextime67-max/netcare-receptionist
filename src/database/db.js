const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'netcare.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── In-memory caches ──────────────────────────────────────────────────────────
const CLINIC_TTL = 5 * 60 * 1000;
const KB_TTL     = 5 * 60 * 1000;
const clinicCache = new Map(); // slug → { data, expiry }
const kbCache     = new Map(); // clinicId → { data, expiry }

function invalidateClinicCache(slug) { clinicCache.delete(slug); }
function invalidateKbCache(clinicId) { kbCache.delete(clinicId); }

function initDb() {
  // ── Core tables (no indexes yet — migrations run first) ───────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS clinics (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      slug             TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      phone_display    TEXT,
      telnyx_api_key   TEXT,
      telnyx_phone     TEXT,
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

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id                INTEGER UNIQUE NOT NULL,
      services                 TEXT,
      doctors                  TEXT,
      locations                TEXT,
      office_hours             TEXT,
      insurance                TEXT,
      appointment_policy       TEXT,
      cancellation_policy      TEXT,
      new_patient_requirements TEXT,
      documents_needed         TEXT,
      faqs                     TEXT,
      transfer_rules           TEXT,
      emergency_instructions   TEXT,
      do_not_answer            TEXT,
      updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS unanswered_questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id  INTEGER,
      call_id    INTEGER,
      question   TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS training_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER NOT NULL,
      source_type TEXT    NOT NULL,
      source_name TEXT,
      raw_text    TEXT    NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS training_faqs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER NOT NULL,
      question    TEXT    NOT NULL,
      answer      TEXT    NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS business_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER NOT NULL,
      rule_text   TEXT    NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS practice_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clinic_id   INTEGER NOT NULL,
      scenario    TEXT,
      language    TEXT DEFAULT 'es',
      transcript  TEXT,
      quality     TEXT,
      notes       TEXT,
      status      TEXT DEFAULT 'active',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE CASCADE
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

  // ── Migrations: appointment location + SMS tracking ──────────────────────

  _addColumnIfMissing('appointments', 'location',          'TEXT');
  _addColumnIfMissing('appointments', 'sms_sent',          'INTEGER DEFAULT 0');
  _addColumnIfMissing('appointments', 'reminder_24h_sent', 'INTEGER DEFAULT 0');
  _addColumnIfMissing('appointments', 'reminder_1h_sent',  'INTEGER DEFAULT 0');

  // ── Migrations: AI voice selection + website KB ──────────────────────────

  _addColumnIfMissing('clinics',        'ai_voice_es',   'TEXT');
  _addColumnIfMissing('clinics',        'ai_voice_en',   'TEXT');
  _addColumnIfMissing('knowledge_base',  'website_url',   'TEXT');
  _addColumnIfMissing('knowledge_base',  'field_sources', 'TEXT');
  _addColumnIfMissing('knowledge_base',  'manual_notes',  'TEXT');
  _addColumnIfMissing('training_faqs',   'sort_order',    'INTEGER DEFAULT 0');
  _addColumnIfMissing('training_sources','sort_order',    'INTEGER DEFAULT 0');

  // ── Migrations: Telnyx telephony ─────────────────────────────────────────
  _addColumnIfMissing('clinics', 'telnyx_api_key', 'TEXT');
  _addColumnIfMissing('clinics', 'telnyx_phone',   'TEXT');
  _addColumnIfMissing('clinics', 'ai_language',    "TEXT DEFAULT 'es'");

  // ── Migrations: Timezone for smart time-based greeting ───────────────────
  _addColumnIfMissing('clinics', 'timezone', "TEXT DEFAULT 'America/New_York'");

  // Back-fill account numbers for any clinic that doesn't have one yet
  const noAcct = db.prepare("SELECT id FROM clinics WHERE account_number IS NULL OR account_number = ''").all();
  for (const row of noAcct) {
    db.prepare("UPDATE clinics SET account_number = ? WHERE id = ?")
      .run(_nextAccountNumber(), row.id);
  }

  // ── Cost management tables ────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_config (
      id                    INTEGER PRIMARY KEY CHECK(id = 1),
      admin_phone           TEXT,
      admin_email           TEXT,
      twilio_rate_per_min   REAL    DEFAULT 0.0085,
      ai_rate_per_call      REAL    DEFAULT 0.08,
      ai_monthly_budget     REAL    DEFAULT 200.0,
      threshold_ai_low      REAL    DEFAULT 5.0,
      threshold_ai_critical REAL    DEFAULT 2.0,
      threshold_twilio_low  REAL    DEFAULT 10.0,
      alerts_enabled        INTEGER DEFAULT 1,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_alerts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type     TEXT    NOT NULL,
      message        TEXT    NOT NULL,
      value          REAL,
      threshold      REAL,
      notified_sms   INTEGER DEFAULT 0,
      notified_email INTEGER DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Indexes (safe now that columns exist) ─────────────────────────────────

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_clinics_slug        ON clinics(slug);
    CREATE INDEX IF NOT EXISTS idx_calls_clinic        ON calls(clinic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_created_at    ON calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_call_type     ON calls(call_type);
    CREATE INDEX IF NOT EXISTS idx_transcripts_call    ON transcripts(call_id);
    CREATE INDEX IF NOT EXISTS idx_appts_clinic        ON appointments(clinic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_msgs_clinic         ON doctor_messages(clinic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_webreq_clinic       ON web_requests(clinic_id, created_at DESC);
  `);

  // ── Seed default clinic from env vars if none exist ───────────────────────

  const count = db.prepare('SELECT COUNT(*) AS n FROM clinics').get().n;
  if (count === 0) {
    db.prepare(`
      INSERT INTO clinics
        (slug, name, telnyx_api_key, telnyx_phone,
         admin_user, admin_pass, clinic_email, email_from,
         gmail_user, gmail_app_pass,
         smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'netcare',
      process.env.CLINIC_NAME       || 'NetCare Clinic',
      process.env.TELNYX_API_KEY    || null,
      process.env.TELNYX_PHONE_NUMBER || null,
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

  // ── Upgrade MDcare IVR to bilingual two-step flow ────────────────────────

  const mdcareForUpgrade = db.prepare("SELECT id, ivr_config FROM clinics WHERE slug = 'mdcare'").get();
  if (mdcareForUpgrade?.ivr_config) {
    let ivrCfg;
    try { ivrCfg = JSON.parse(mdcareForUpgrade.ivr_config); } catch { ivrCfg = null; }
    if (ivrCfg && !ivrCfg.languageMenu) {
      ivrCfg.languageMenu = {
        greeting:    'Gracias por comunicarse con MDcare Medical Centers.',
        options: [
          { digit: '1', lang: 'es', label: 'Spanish' },
          { digit: '2', lang: 'en', label: 'English' },
        ],
        repeatDigit: '9',
        voice:       'Polly.Lupe-Neural',
        langCode:    'es-US',
      };
      db.prepare("UPDATE clinics SET ivr_config = ? WHERE slug = 'mdcare'")
        .run(JSON.stringify(ivrCfg));
      console.log('[DB] Upgraded MDcare IVR config to bilingual two-step flow.');
    }
  }

  // ── Seed MDcare Knowledge Base ────────────────────────────────────────────

  const mdcareRow = db.prepare("SELECT id FROM clinics WHERE slug = 'mdcare'").get();
  if (mdcareRow && !db.prepare('SELECT id FROM knowledge_base WHERE clinic_id = ?').get(mdcareRow.id)) {
    db.prepare(`
      INSERT INTO knowledge_base
        (clinic_id, services, doctors, locations, office_hours, insurance,
         appointment_policy, cancellation_policy, new_patient_requirements,
         documents_needed, faqs, transfer_rules, emergency_instructions, do_not_answer)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      mdcareRow.id,
      /* services */
      `MDcare provides comprehensive medical services across all three locations:

Primary Care (All Locations):
- Annual physical exams and wellness visits
- Chronic disease management (diabetes, hypertension, high cholesterol, thyroid)
- Acute illness treatment (infections, flu, minor injuries)
- Preventive care and health screenings
- Vaccinations and immunizations
- On-site lab work (blood draws, urinalysis, rapid strep, flu, EKG)

Specialty Services:
- Pediatrics (newborn through age 18) — All locations
- Women's Health / OB-GYN — Hialeah and Coral Gables
- Cardiology consultations — Hialeah
- Dermatology — Coral Gables
- Orthopedics and sports medicine — Homestead
- Nutrition counseling — All locations
- Mental and behavioral health referrals — All locations`,

      /* doctors */
      `Hialeah Medical Center:
- Dr. Maria Rodriguez, MD — Internal Medicine, Primary Care
- Dr. Carlos Mendez, MD — Cardiology
- Dr. Sofia Alvarez, MD — Pediatrics
- Dr. Laura Fernandez, NP — Family Medicine and Women's Health

Homestead Medical Center:
- Dr. James Williams, MD — Internal Medicine, Family Medicine
- Dr. Ana Garcia, MD — Women's Health, OB-GYN
- Dr. Robert Chen, MD — Orthopedics, Sports Medicine
- Dr. Patricia Ruiz, NP — Primary Care

Coral Gables Medical Center:
- Dr. Elena Vasquez, MD — Pediatrics, Adolescent Medicine
- Dr. Michael Brown, MD — Dermatology
- Dr. Patricia Torres, MD — Internal Medicine, Primary Care
- Dr. David Kim, MD — General Medicine

To schedule with a specific provider, mention their name when booking. Availability varies by day.`,

      /* locations */
      `Hialeah Medical Center
1250 W 49th Street, Hialeah, FL 33012
Phone: (305) 555-0100 | Fax: (305) 555-0101
Free on-site parking. Wheelchair accessible.

Homestead Medical Center
975 N Homestead Blvd, Homestead, FL 33030
Phone: (305) 555-0200 | Fax: (305) 555-0201
Free on-site parking. Wheelchair accessible.

Coral Gables Medical Center
396 Alhambra Circle, Coral Gables, FL 33134
Phone: (305) 555-0300 | Fax: (305) 555-0301
Street parking and nearby garage. Wheelchair accessible.`,

      /* office_hours */
      `Hialeah Medical Center:
Monday – Friday: 8:00 AM – 6:00 PM | Saturday: 9:00 AM – 2:00 PM | Sunday: Closed

Homestead Medical Center:
Monday – Friday: 8:00 AM – 5:00 PM | Saturday: 9:00 AM – 1:00 PM | Sunday: Closed

Coral Gables Medical Center:
Monday – Friday: 8:00 AM – 6:00 PM | Saturday: 10:00 AM – 1:00 PM | Sunday: Closed

MDcare does not offer walk-in urgent care after hours. For non-emergency after-hours needs, visit a nearby urgent care center. For medical emergencies, call 911 immediately.`,

      /* insurance */
      `MDcare accepts most major insurance plans including:
- Medicare and Medicare Advantage (AARP, Humana Gold, United AARP, WellCare, Devoted Health)
- Medicaid (Florida Medicaid, Staywell, Sunshine Health, Molina Healthcare)
- Blue Cross Blue Shield / Florida Blue (all plans)
- Aetna (HMO, PPO, Medicare Advantage)
- Cigna (HMO, PPO)
- United Healthcare (HMO, PPO, Medicare Advantage)
- Humana (HMO, PPO, Medicare Advantage)
- Simply Healthcare, AvMed, Tricare

Self-pay patients are welcome — ask about our self-pay discount program.
Coverage varies by provider and plan. Patients are responsible for co-pays and deductibles at the time of service.`,

      /* appointment_policy */
      `Appointments are required — we do not accept walk-ins.
- New patient visits: 60–90 minutes (allow extra time for paperwork)
- Follow-up visits: 20–30 minutes
- Annual physicals: 45–60 minutes
- Same-day appointments may be available — call early in the morning
- Telehealth video visits are available for established patients

Please arrive 15 minutes early. Bring your insurance card, photo ID, and medication list.
A parent or guardian must accompany patients under 18.

To schedule through this line: our virtual assistant will collect your name, preferred date/time, and reason for visit. A scheduler will confirm within one business day.`,

      /* cancellation_policy */
      `- Cancel or reschedule at least 24 hours before your appointment
- Late cancellations (under 24 hours): $25 fee may apply
- No-shows: $50 fee may apply
- Three or more no-shows in 12 months may require prepayment for future visits

To cancel or reschedule: call your location directly during business hours.
Exceptions for documented medical emergencies or severe weather.`,

      /* new_patient_requirements */
      `Required at First Visit:
1. Valid government-issued photo ID (driver's license, state ID, or passport)
2. Insurance card(s) — front and back
3. Referral authorization (if required by your insurance)
4. Completed new patient registration forms (available at the office or online)

Medical History to Bring:
- List of all current medications (name, dosage, frequency)
- Relevant medical records from previous providers
- Immunization records (required for children under 12)
- Known allergies and prior adverse reactions

For Minor Patients (Under 18):
- Parent or legal guardian must be present and sign consent forms
- Legal guardianship documentation required if guardian is not biological parent`,

      /* documents_needed */
      `Bring to Every Appointment:
- Photo ID
- Insurance card(s)
- List of current medications with dosages
- List of allergies

For Specialist or Follow-Up Visits:
- Lab results or imaging from past 12 months (if relevant)
- Referral authorization from your primary care provider
- Notes from other specialists treating the same condition

For Workers' Compensation / Accident Visits:
- Claim number and insurance carrier
- Employer contact information`,

      /* faqs */
      `Q: How do I request a prescription refill?
A: Call your location and ask for the nursing staff. Have your medication name, dosage, and pharmacy information ready. Allow 48–72 business hours. Controlled substances require an in-person visit.

Q: How do I get my lab or test results?
A: Results are available within 3–7 business days. Your provider or nurse will call you with significant results. Results are also accessible through the MDcare patient portal.

Q: Does MDcare have a patient portal?
A: Yes. The MDcare patient portal lets you view lab results, request prescription refills, message your care team, and request appointments. Ask staff at your location for enrollment instructions.

Q: Do you treat children?
A: Yes. MDcare has pediatric providers at all three locations, specializing in care from newborns through age 18.

Q: Do you offer telehealth or video visits?
A: Yes, telehealth video appointments are available for established patients for appropriate conditions. Ask when scheduling if your visit qualifies.

Q: How do I get a referral to a specialist?
A: Your primary care doctor provides referrals. Call your location and ask to leave a message with your name, date of birth, and the type of specialist needed.

Q: What if I have an urgent question after hours?
A: Call your location — the after-hours message will direct you to our nurse advice line. For any medical emergency, call 911 immediately.`,

      /* transfer_rules */
      `Transfer to live staff when the caller:
- Asks to speak with a specific doctor or nurse directly
- Has an urgent clinical question requiring immediate clinical guidance
- Is calling about billing, payments, or financial assistance
- Needs medical records released
- Explicitly asks to speak with a person or office manager

Transfer numbers by location:
- Hialeah Medical Center: (305) 555-0100
- Homestead Medical Center: (305) 555-0200
- Coral Gables Medical Center: (305) 555-0300

If the patient has not selected a location, ask which location they are calling about before transferring.`,

      /* emergency_instructions */
      `EMERGENCY PROTOCOL — HIGHEST PRIORITY:

If the caller describes ANY life-threatening symptom, say immediately:
"If this is a medical emergency, please call 911 or go to the nearest emergency room immediately."
Set emergencyDetected: true.

Always direct to 911 for:
- Chest pain, pressure, or tightness
- Difficulty breathing or shortness of breath
- Stroke symptoms: facial drooping, arm weakness, slurred speech, sudden severe headache
- Severe allergic reaction: throat swelling, difficulty breathing
- Loss of consciousness or unresponsiveness
- Active seizure
- Severe uncontrolled bleeding
- Suspected overdose or poisoning
- Suicidal thoughts or intent to harm self or others
- High fever in infant under 3 months
- Severe head or neck injury

MDcare clinics do NOT have emergency room capabilities. Always direct emergencies to 911 first — before any other action.`,

      /* do_not_answer */
      `Do NOT answer the following. Respond with: "I do not have that information available, but I can take a message and have the clinic contact you." and set unanswered: true.

Medical Topics — Never Answer:
- Medical advice, treatment recommendations, or diagnosis
- Medication names, dosages, or drug interactions
- Interpretation of symptoms (whether something is serious or not)
- Lab result values or what results mean
- Prescription approval or refill decisions
- Whether a specific treatment is appropriate for a condition

Administrative Topics — Do Not Speculate:
- Exact wait times for appointments (unpredictable)
- Whether a specific doctor is available on a specific date
- Exact pricing for procedures (varies by insurance)
- Insurance authorization status for specific procedures
- Billing disputes or payment arrangements
- Information about other patients (HIPAA)

Out of Scope — Do Not Answer:
- Information about other medical providers or clinics
- Medical research or clinical study information
- Legal, malpractice, or workers' compensation decisions
- Competitor pricing or service comparisons`
    );
    console.log('[DB] Seeded MDcare Knowledge Base.');
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
       telnyx_api_key, telnyx_phone,
       admin_user, admin_pass, clinic_email, email_from,
       gmail_user, gmail_app_pass, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    data.telnyxApiKey || null, data.telnyxPhone || null,
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
  const hit = clinicCache.get(slug);
  if (hit && Date.now() < hit.expiry) return hit.data;
  const row = db.prepare('SELECT * FROM clinics WHERE slug = ?').get(slug);
  if (row) clinicCache.set(slug, { data: row, expiry: Date.now() + CLINIC_TTL });
  return row;
}

function getClinicById(id) {
  return db.prepare('SELECT * FROM clinics WHERE id = ?').get(id);
}

function getClinicByTelnyxPhone(phone) {
  if (!phone) return null;
  return db.prepare('SELECT * FROM clinics WHERE telnyx_phone = ?').get(phone) || null;
}

function updateClinic(id, data) {
  const allowed = [
    'name', 'phone_display',
    'contact_person', 'contact_phone', 'contact_email',
    'business_type', 'monthly_plan', 'monthly_price', 'payment_status',
    'status', 'support_notes', 'onboarded_at', 'suspended_at',
    'telnyx_api_key', 'telnyx_phone',
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
    telnyx_api_key: data.telnyxApiKey,
    telnyx_phone:   data.telnyxPhone,
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
  const row = db.prepare('SELECT slug FROM clinics WHERE id = ?').get(id);
  if (row) invalidateClinicCache(row.slug);
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
    SELECT calls.*, clinics.name AS clinic_name, clinics.slug AS clinic_slug,
           appt.sms_sent AS appt_sms_sent, appt.location AS appt_location
    FROM calls
    INNER JOIN clinics ON calls.clinic_id = clinics.id
    LEFT JOIN appointments appt ON appt.call_id = calls.id
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
    INSERT INTO appointments (clinic_id, call_id, patient_name, patient_phone, preferred_date, preferred_time, reason, location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clinicId, callId, data.name, data.phone, data.appointmentDate, data.appointmentTime, data.reason, data.location || null)
    .lastInsertRowid;
}

// status: 1 = sent, 2 = failed
function updateAppointmentSmsStatus(apptId, status) {
  db.prepare('UPDATE appointments SET sms_sent = ? WHERE id = ?').run(status, apptId);
}

function markReminderSent(apptId, reminderType) {
  const col = reminderType === '24h' ? 'reminder_24h_sent' : 'reminder_1h_sent';
  db.prepare(`UPDATE appointments SET ${col} = 1 WHERE id = ?`).run(apptId);
}

// Returns appointments with confirmed date+time whose reminder hasn't been sent yet.
// windowStart / windowEnd are ISO datetime strings for the target reminder window.
function getAppointmentsDueForReminder(reminderType, windowStart, windowEnd) {
  const col = reminderType === '24h' ? 'reminder_24h_sent' : 'reminder_1h_sent';
  return db.prepare(`
    SELECT a.*, c.name AS clinic_name, c.slug AS clinic_slug,
           c.telnyx_api_key, c.telnyx_phone, c.sms_follow_up_enabled,
           ca.language
    FROM appointments a
    INNER JOIN clinics c ON a.clinic_id = c.id
    LEFT JOIN calls ca ON ca.id = a.call_id
    WHERE a.preferred_date IS NOT NULL
      AND a.preferred_time IS NOT NULL
      AND a.${col} = 0
      AND a.status IN ('pending', 'confirmed')
      AND datetime(a.preferred_date || ' ' || a.preferred_time) BETWEEN datetime(?) AND datetime(?)
  `).all(windowStart, windowEnd);
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
           ai_industry_template, ai_master_prompt,
           ai_voice_es, ai_voice_en, ai_language,
           telnyx_api_key,
           timezone
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
    'ai_voice_es', 'ai_voice_en', 'ai_language',
    'telnyx_api_key',
    'timezone',
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
    ai_voice_es:                 data.voiceEs,
    ai_voice_en:                 data.voiceEn,
    ai_language:                 data.aiLanguage,
    telnyx_api_key:              data.telnyxApiKey,
    timezone:                    data.timezone,
  };
  const filtered = Object.fromEntries(
    allowed.filter(k => map[k] !== undefined).map(k => [k, map[k] ?? null])
  );
  if (!Object.keys(filtered).length) return;
  const sets = Object.keys(filtered).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE clinics SET ${sets} WHERE id = ?`).run(...Object.values(filtered), id);
  const row = db.prepare('SELECT slug FROM clinics WHERE id = ?').get(id);
  if (row) invalidateClinicCache(row.slug);
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

function updateClinicTelnyx(id, data) {
  const allowed = ['telnyx_api_key', 'telnyx_phone'];
  const map = {
    telnyx_api_key: data.telnyxApiKey,
    telnyx_phone:   data.telnyxPhone,
  };
  const filtered = Object.fromEntries(
    allowed.filter(k => map[k] !== undefined).map(k => [k, map[k]])
  );
  if (!Object.keys(filtered).length) return;
  const sets = Object.keys(filtered).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE clinics SET ${sets} WHERE id = ?`).run(...Object.values(filtered), id);
  const row = db.prepare('SELECT slug FROM clinics WHERE id = ?').get(id);
  if (row) invalidateClinicCache(row.slug);
}

function getClinicBilling(id) {
  return db.prepare(`
    SELECT id, slug, name, account_number, contact_person, contact_email, contact_phone,
           business_type, monthly_plan, monthly_price, payment_status, status,
           onboarded_at, suspended_at, created_at
    FROM clinics WHERE id = ?
  `).get(id);
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

const KB_FIELDS = [
  'services','doctors','locations','office_hours','insurance',
  'appointment_policy','cancellation_policy','new_patient_requirements',
  'documents_needed','faqs','transfer_rules','emergency_instructions','do_not_answer',
];

function getKnowledgeBase(clinicId) {
  const hit = kbCache.get(clinicId);
  if (hit && Date.now() < hit.expiry) return hit.data;
  const row = db.prepare('SELECT * FROM knowledge_base WHERE clinic_id = ?').get(clinicId) || null;
  kbCache.set(clinicId, { data: row, expiry: Date.now() + KB_TTL });
  return row;
}

function upsertKnowledgeBase(clinicId, data) {
  const existing = db.prepare('SELECT id FROM knowledge_base WHERE clinic_id = ?').get(clinicId);
  const vals = KB_FIELDS.map(f => data[f] != null ? String(data[f]) : null);
  if (existing) {
    const sets = KB_FIELDS.map(f => `${f} = ?`).join(', ');
    db.prepare(`UPDATE knowledge_base SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?`)
      .run(...vals, clinicId);
  } else {
    db.prepare(`INSERT INTO knowledge_base (clinic_id, ${KB_FIELDS.join(', ')}) VALUES (?, ${KB_FIELDS.map(() => '?').join(', ')})`)
      .run(clinicId, ...vals);
  }
  invalidateKbCache(clinicId);
}

function saveWebsiteUrl(clinicId, url) {
  const existing = db.prepare('SELECT id FROM knowledge_base WHERE clinic_id = ?').get(clinicId);
  if (existing) {
    db.prepare('UPDATE knowledge_base SET website_url = ?, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?')
      .run(url || null, clinicId);
  } else {
    db.prepare('INSERT INTO knowledge_base (clinic_id, website_url) VALUES (?, ?)').run(clinicId, url || null);
  }
  invalidateKbCache(clinicId);
}

// ── Training Center ───────────────────────────────────────────────────────────

function getTrainingSources(clinicId) {
  return db.prepare('SELECT id, clinic_id, source_type, source_name, created_at, LENGTH(raw_text) AS char_count FROM training_sources WHERE clinic_id = ? ORDER BY created_at DESC').all(clinicId);
}

function getTrainingSourceText(clinicId) {
  return db.prepare('SELECT id, source_type, source_name, raw_text FROM training_sources WHERE clinic_id = ? ORDER BY created_at ASC').all(clinicId);
}

function addTrainingSource(clinicId, sourceType, sourceName, rawText) {
  const r = db.prepare(
    'INSERT INTO training_sources (clinic_id, source_type, source_name, raw_text) VALUES (?, ?, ?, ?)'
  ).run(clinicId, sourceType, sourceName || null, rawText);
  return r.lastInsertRowid;
}

function deleteTrainingSource(id, clinicId) {
  db.prepare('DELETE FROM training_sources WHERE id = ? AND clinic_id = ?').run(id, clinicId);
}

function getTrainingFaqs(clinicId) {
  return db.prepare('SELECT * FROM training_faqs WHERE clinic_id = ? ORDER BY sort_order, id').all(clinicId);
}

function addTrainingFaq(clinicId, question, answer) {
  const r = db.prepare('INSERT INTO training_faqs (clinic_id, question, answer) VALUES (?, ?, ?)').run(clinicId, question.trim(), answer.trim());
  return r.lastInsertRowid;
}

function updateTrainingFaq(id, clinicId, question, answer) {
  db.prepare('UPDATE training_faqs SET question = ?, answer = ? WHERE id = ? AND clinic_id = ?').run(question.trim(), answer.trim(), id, clinicId);
}

function deleteTrainingFaq(id, clinicId) {
  db.prepare('DELETE FROM training_faqs WHERE id = ? AND clinic_id = ?').run(id, clinicId);
}

function getBusinessRules(clinicId) {
  return db.prepare('SELECT * FROM business_rules WHERE clinic_id = ? ORDER BY sort_order, id').all(clinicId);
}

function addBusinessRule(clinicId, ruleText) {
  const r = db.prepare('INSERT INTO business_rules (clinic_id, rule_text) VALUES (?, ?)').run(clinicId, ruleText.trim());
  return r.lastInsertRowid;
}

function updateBusinessRule(id, clinicId, ruleText) {
  db.prepare('UPDATE business_rules SET rule_text = ? WHERE id = ? AND clinic_id = ?').run(ruleText.trim(), id, clinicId);
}

function deleteBusinessRule(id, clinicId) {
  db.prepare('DELETE FROM business_rules WHERE id = ? AND clinic_id = ?').run(id, clinicId);
}

function saveManualNotes(clinicId, notes) {
  const existing = db.prepare('SELECT id FROM knowledge_base WHERE clinic_id = ?').get(clinicId);
  if (existing) {
    db.prepare('UPDATE knowledge_base SET manual_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?').run(notes || null, clinicId);
  } else {
    db.prepare('INSERT INTO knowledge_base (clinic_id, manual_notes) VALUES (?, ?)').run(clinicId, notes || null);
  }
  invalidateKbCache(clinicId);
}

function getTrainingStatus(clinicId) {
  const src  = db.prepare('SELECT COUNT(*) as cnt, MAX(created_at) as last_added FROM training_sources WHERE clinic_id = ?').get(clinicId);
  const faqs = db.prepare('SELECT COUNT(*) as cnt FROM training_faqs WHERE clinic_id = ?').get(clinicId);
  const rules= db.prepare('SELECT COUNT(*) as cnt FROM business_rules WHERE clinic_id = ?').get(clinicId);
  const kb   = db.prepare('SELECT updated_at, manual_notes FROM knowledge_base WHERE clinic_id = ?').get(clinicId);
  return {
    sourcesCount:   src.cnt,
    lastSourceAdded: src.last_added,
    faqsCount:      faqs.cnt,
    rulesCount:     rules.cnt,
    lastTrained:    kb?.updated_at || null,
    manualNotes:    kb?.manual_notes || '',
  };
}

// ── Practice Sessions ─────────────────────────────────────────────────────────

function createPracticeSession(clinicId, scenario, language) {
  const r = db.prepare(
    'INSERT INTO practice_sessions (clinic_id, scenario, language) VALUES (?, ?, ?)'
  ).run(clinicId, scenario || null, language || 'es');
  return r.lastInsertRowid;
}

function getPracticeSession(id, clinicId) {
  return db.prepare('SELECT * FROM practice_sessions WHERE id = ? AND clinic_id = ?').get(id, clinicId);
}

function updatePracticeTranscript(id, clinicId, transcript) {
  db.prepare('UPDATE practice_sessions SET transcript = ? WHERE id = ? AND clinic_id = ?')
    .run(JSON.stringify(transcript), id, clinicId);
}

function savePracticeResult(id, clinicId, quality, notes) {
  db.prepare('UPDATE practice_sessions SET quality = ?, notes = ?, status = ? WHERE id = ? AND clinic_id = ?')
    .run(JSON.stringify(quality), notes || null, 'saved', id, clinicId);
}

function listPracticeSessions(clinicId, limit) {
  return db.prepare(
    'SELECT id, scenario, language, status, notes, created_at FROM practice_sessions WHERE clinic_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(clinicId, limit || 20);
}

function deletePracticeSession(id, clinicId) {
  db.prepare('DELETE FROM practice_sessions WHERE id = ? AND clinic_id = ?').run(id, clinicId);
}

function upsertKbSources(clinicId, sources) {
  const json = typeof sources === 'string' ? sources : JSON.stringify(sources);
  const existing = db.prepare('SELECT id FROM knowledge_base WHERE clinic_id = ?').get(clinicId);
  if (existing) {
    db.prepare('UPDATE knowledge_base SET field_sources = ?, updated_at = CURRENT_TIMESTAMP WHERE clinic_id = ?')
      .run(json, clinicId);
  } else {
    db.prepare('INSERT INTO knowledge_base (clinic_id, field_sources) VALUES (?, ?)').run(clinicId, json);
  }
  invalidateKbCache(clinicId);
}

function logUnansweredQuestion(clinicId, callId, question) {
  if (!question?.trim()) return;
  db.prepare('INSERT INTO unanswered_questions (clinic_id, call_id, question) VALUES (?, ?, ?)')
    .run(clinicId || null, callId || null, question.trim());
}

function getUnansweredQuestions(clinicId, limit = 50, offset = 0) {
  const where  = clinicId ? 'WHERE uq.clinic_id = ?' : '';
  const params = clinicId ? [clinicId, limit, offset] : [limit, offset];
  return db.prepare(`
    SELECT uq.id, uq.clinic_id, uq.call_id, uq.question, uq.created_at, c.name AS clinic_name
    FROM unanswered_questions uq
    LEFT JOIN clinics c ON c.id = uq.clinic_id
    ${where}
    ORDER BY uq.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params);
}

// ── Cost Management ───────────────────────────────────────────────────────────

const COST_CONFIG_DEFAULTS = {
  admin_phone: null, admin_email: null,
  twilio_rate_per_min: 0.0085, ai_rate_per_call: 0.08,
  ai_monthly_budget: 200.0,
  threshold_ai_low: 5.0, threshold_ai_critical: 2.0, threshold_twilio_low: 10.0,
  alerts_enabled: 1,
};

function getCostConfig() {
  return db.prepare('SELECT * FROM cost_config WHERE id = 1').get() || { id: null, ...COST_CONFIG_DEFAULTS };
}

function saveCostConfig(data) {
  const d = { ...COST_CONFIG_DEFAULTS, ...data };
  db.prepare(`
    INSERT INTO cost_config
      (id, admin_phone, admin_email, twilio_rate_per_min, ai_rate_per_call,
       ai_monthly_budget, threshold_ai_low, threshold_ai_critical,
       threshold_twilio_low, alerts_enabled, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      admin_phone           = excluded.admin_phone,
      admin_email           = excluded.admin_email,
      twilio_rate_per_min   = excluded.twilio_rate_per_min,
      ai_rate_per_call      = excluded.ai_rate_per_call,
      ai_monthly_budget     = excluded.ai_monthly_budget,
      threshold_ai_low      = excluded.threshold_ai_low,
      threshold_ai_critical = excluded.threshold_ai_critical,
      threshold_twilio_low  = excluded.threshold_twilio_low,
      alerts_enabled        = excluded.alerts_enabled,
      updated_at            = CURRENT_TIMESTAMP
  `).run(
    d.admin_phone || null, d.admin_email || null,
    +d.twilio_rate_per_min, +d.ai_rate_per_call,
    +d.ai_monthly_budget,
    +d.threshold_ai_low, +d.threshold_ai_critical, +d.threshold_twilio_low,
    d.alerts_enabled ? 1 : 0,
  );
}

function logCostAlert(alertType, message, value, threshold) {
  return db.prepare(
    'INSERT INTO cost_alerts (alert_type, message, value, threshold) VALUES (?, ?, ?, ?)'
  ).run(alertType, message, value ?? null, threshold ?? null).lastInsertRowid;
}

function getLastAlertByType(alertType) {
  return db.prepare(
    'SELECT * FROM cost_alerts WHERE alert_type = ? ORDER BY created_at DESC LIMIT 1'
  ).get(alertType) || null;
}

function getCostAlerts(limit = 50) {
  return db.prepare(
    'SELECT * FROM cost_alerts ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

module.exports = {
  db,
  initDb,
  // cache invalidation
  invalidateClinicCache,
  invalidateKbCache,
  // clinics
  createClinic,
  getClinics,
  getClinicBySlug,
  getClinicById,
  getClinicByTelnyxPhone,
  updateClinic,
  updateClinicTelnyx,
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
  updateAppointmentSmsStatus,
  markReminderSent,
  getAppointmentsDueForReminder,
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
  // knowledge base
  getKnowledgeBase,
  upsertKnowledgeBase,
  upsertKbSources,
  saveWebsiteUrl,
  logUnansweredQuestion,
  getUnansweredQuestions,
  // cost management
  getCostConfig,
  saveCostConfig,
  logCostAlert,
  getLastAlertByType,
  getCostAlerts,
  // training center
  getTrainingSources,
  getTrainingSourceText,
  addTrainingSource,
  deleteTrainingSource,
  getTrainingFaqs,
  addTrainingFaq,
  updateTrainingFaq,
  deleteTrainingFaq,
  getBusinessRules,
  addBusinessRule,
  updateBusinessRule,
  deleteBusinessRule,
  saveManualNotes,
  getTrainingStatus,
  // practice sessions
  createPracticeSession,
  getPracticeSession,
  updatePracticeTranscript,
  savePracticeResult,
  listPracticeSessions,
  deletePracticeSession,
};
