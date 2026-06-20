# NetCare AI Receptionist — Project Status

**Last updated:** 2026-06-20
**Branch:** `master`
**Latest commit:** `35b6051`

---

## Completed Phases

### Phase 1 — Core AI Receptionist
- Anthropic Claude (`claude-sonnet-4-6`) integration
- Inbound call handling via Twilio voice webhooks
- Bilingual support (English / Spanish, auto-detected)
- Intent classification: appointment, doctor message, general inquiry
- Emergency detection with immediate escalation response
- In-memory session management per `CallSid`
- Call records and transcripts stored in SQLite

### Phase 2 — Multi-Clinic Architecture + Super Admin v1
- Multi-clinic data model (`clinic_id` on every table)
- Clinic slug-based webhook routing (`/webhook/:slug/voice`)
- Super Admin panel (HTTP Basic Auth) at `/superadmin/`
- Create / edit / suspend / delete clinics
- Per-clinic Twilio credentials, email config, billing plan
- Global dashboard with stats across all clinics
- Per-clinic admin dashboard at `/admin/:slug`

### Phase 3 — Client Portal
- JWT-authenticated portal at `/portal/:slug`
- Per-clinic login with `admin_pass` credential
- Call log view (read-only)
- Appointment management
- Doctor messages view
- Web requests / contact form submissions
- Billing status display
- Client portal **cannot** access AI configuration or Twilio settings

### Phase 4 — AI Assistant Configuration (Super Admin only)
- Per-clinic AI config stored on `clinics` table (11 columns)
- Fields: assistant name, English greeting, Spanish greeting, business description, services, office hours, appointment instructions, after-hours message, transfer rules, emergency instructions
- FAQ builder (dynamic Q&A pairs, stored as JSON)
- AI Test Simulator inside the edit slide-over (chat UI, calls real AI)
- All AI settings are **Super Admin only** — not exposed to client portal

### Phase 5 — Industry Templates + Master Prompt Engine
- 9 industry templates: Medical Clinic, Dental Office, Tax Office, Law Firm, Insurance Agency, Real Estate Office, IT Support/MSP, Restaurant, General Business
- Each template provides: persona line, tone, intent examples, extra rules
- Master Prompt field (Super Admin only) — injected last, overrides all other instructions
- Prompt Preview modal: shows the fully assembled system prompt with character/token count and section summary
- `buildSystemPrompt()` assembles: template persona → tone → call types → business info → services → hours → appt instructions → transfer rules → after-hours → emergency → FAQ → industry rules → master prompt
- Backward-compatible: accepts plain string (clinic name) or full clinic object

### Phase 9 — Knowledge Base System (AI Intelligence) ✅ LATEST

- **Per-clinic Knowledge Base**: 13 content categories stored in `knowledge_base` table (`services`, `doctors`, `locations`, `office_hours`, `insurance`, `appointment_policy`, `cancellation_policy`, `new_patient_requirements`, `documents_needed`, `faqs`, `transfer_rules`, `emergency_instructions`, `do_not_answer`).
- **AI Prompt Injection**: `buildKbPromptSection()` appends approved clinic content + medical safety rules to Claude system prompt on every call. When a caller selects an IVR location, that center's details are highlighted in the KB section.
- **Fallback + Unanswered Tracking**: AI returns `"unanswered": true` in JSON when question is outside the KB. Webhook logs it to `unanswered_questions` table. Super Admin can review gaps to improve the KB.
- **Medical Safety Rules**: Hardcoded safety guardrails in every KB prompt — no medical advice, no diagnoses, no medication guidance; emergency always redirected to 911.
- **MDcare Sample Content**: All 3 locations (Hialeah / Homestead / Coral Gables) seeded with full services, doctors, locations, hours, insurance, policies, FAQs, and transfer rules.
- **Super Admin Knowledge Base View**: Nav button + full-page view with 13 textarea cards, clinic dropdown, Save button, and status indicator. Super Admin only — not in client portal.
- **Test Simulator**: Chat UI inside KB view — type a patient question, call real Claude with the saved KB prompt, see response + `Unanswered` or `Emergency` badges.
- **Unanswered Questions Analytics**: Table of questions from real calls that the AI couldn't answer, per clinic, sortable by date.
- **4 KB API Routes**: `GET /api/kb/:id`, `PUT /api/kb/:id`, `GET /api/kb/:id/unanswered`, `POST /api/kb/test`.
- **Tests**: 35 / 35 passing (11 new KB tests: DB helpers + prompt builder).

### Phase 8 — IVR Menu, Spanish Voice Flow & Bug Fixes ✅

- **DTMF IVR menu** (`ivr_enabled` / `ivr_config` per clinic): Callers hear a spoken menu and press a digit to select a location before the AI starts. Config is stored as JSON on the clinic record; any clinic can enable IVR without code changes.
- **MDcare multi-location clinic**: Seeded with 3-location IVR (Hialeah / Homestead / Coral Gables). New routes: `/:slug/ivr` (repeat + 2-timeout AI fallback) and `/:slug/ivr-select` (DTMF digit handler).
- **Selected location injected into AI system prompt**: After digit selection, `session.selectedCenter` is appended to the Claude system prompt so all appointment scheduling, doctor messages, call transfers, voicemail routing, and analytics use the chosen location.
- **Spanish-first voice flow**: Default session language changed from `en` to `es`. Initial greeting, no-input message, voicemail offer, and timeout farewell all use Spanish. Voice: `Polly.Lupe` (female, es-US). Clinics without IVR speak Spanish by default.
- **Greetings updated**: `getInitialGreeting` checks `ai_greeting_es` before `ai_greeting_en`. `getTimeoutGoodbye` now accepts `clinicName` for a personalized farewell.
- **JavaScript syntax bug fixes** (Super Admin navigation): Two syntax errors in `superadmin.html` were preventing all JavaScript from executing — an unescaped `/` inside a regex literal (`parseSayText`) and single quotes inside a single-quoted string (`resetWebhookSim`). Both fixed; navigation is fully functional.
- **Tests**: 24 / 24 passing (unchanged — IVR logic is integration-tested directly against live routes).

### Phase 7 — SMS Follow-up, Voicemail, Analytics & Production Readiness ✅

- **SMS follow-up service** (`src/services/sms.js`): After a completed appointment call, sends patient a confirmation SMS; after a doctor message, sends receipt SMS; after a missed call / silence timeout, sends missed-call SMS; after a recorded voicemail, sends acknowledgement SMS. Per-clinic toggle (`sms_follow_up_enabled`). No SMS sent if Twilio not configured or toggle is off.
- **Voicemail recording**: On 2nd silence timeout, AI offers voicemail with `<Record>` TwiML. Recording URL stored on `calls.recording_url`; `voicemail_left` flag set. New routes: `/:slug/voicemail`, `/:slug/recording-complete`.
- **Missed call handling**: After 3 silences (caller hangs up without speaking) → status set to `abandoned` → missed-call SMS sent to caller.
- **Voicemail status** added to call log filter and analytics breakdown.
- **Twilio number provisioning**: Super Admin can search available numbers by area code (`GET /superadmin/api/clinics/:id/twilio/numbers`), purchase and auto-configure webhook (`POST /superadmin/api/clinics/:id/twilio/provision`), or set webhook URLs on an existing number (`POST /superadmin/api/clinics/:id/twilio/configure-webhook`). Full UI in Technical Setup tab.
- **Analytics dashboard** (`GET /superadmin/api/analytics`): Returns daily call volume (up to 90 days), intent breakdown, language split, avg duration, completion rate, emergency count. New "Analytics" view in Super Admin with CSS bar chart, breakdown bars, and summary KPI cards.
- **System health check** (`GET /superadmin/api/health`): Validates DB connectivity, Anthropic API key, App URL, Twilio configuration, Portal Secret. Health widget on Dashboard auto-loads on page open.
- **Phase 7 DB migrations**: `calls.recording_url`, `calls.voicemail_left`, `clinics.sms_follow_up_enabled`.
- **Test suite** (24 tests, Node built-in `node:test`): Analytics logic, SMS guard conditions, health check logic, DB migration compatibility. Run with `npm test`.

### Phase 6 — Real Twilio Integration
- **Credential validation**: POSTs to `/superadmin/api/clinics/:id/twilio/test`, validates account SID + Auth Token via Twilio REST API, looks up phone number capabilities
- **Live call transfer**: AI flags `transfer: true` → webhook emits `<Dial>` TwiML with 30s timeout, logs call as `status: transferred`
- **Transfer phone field**: `transfer_phone` column per clinic (set in Technical tab)
- **Outbound test call**: Super Admin can trigger a real test call to any number via Twilio REST API
- **Webhook Call Simulator**: Browser drives `/webhook/:slug/voice` and `/webhook/:slug/gather` with fake `CallSid`, full chat UI showing TwiML `<Say>` responses
- **Global Call Log**: Paginated table across all clinics with clinic/status/date filters
- **Call transcript modal**: Full conversation replay for any call
- **Live active-calls counter**: Dashboard stat card refreshes every 10 seconds via `/superadmin/api/stats/live`
- **Call log API**: `GET /superadmin/api/calls` with filter + pagination, `GET /superadmin/api/calls/:id` with transcript

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ / Express 4 |
| Database | SQLite via `better-sqlite3` (WAL mode, FK enforcement) |
| AI | Anthropic Claude `claude-sonnet-4-6` |
| Voice | Twilio Voice (TwiML webhooks) |
| Auth — Super Admin | HTTP Basic Auth (`express-basic-auth`) |
| Auth — Client Portal | JWT (`jsonwebtoken`, 8h tokens, `PORTAL_SECRET`) |
| Frontend | Vanilla JS + Tailwind CSS (CDN) |
| Email | Nodemailer (Gmail / SMTP) |

---

## Twilio Integration Status

| Capability | Status |
|---|---|
| Store SID / Auth Token / Phone per clinic | ✅ Done |
| Signature validation on webhooks | ✅ Done (optional per clinic) |
| Credential validation UI | ✅ Done |
| Inbound voice webhook flow | ✅ Done |
| Bilingual TwiML (`<Say>` with Polly voices) | ✅ Done |
| Speech recognition (`<Gather input="speech">`) | ✅ Done |
| No-input / silence handling | ✅ Done |
| Status callback (duration, final status) | ✅ Done |
| Live call transfer (`<Dial>`) | ✅ Done |
| Outbound test call | ✅ Done |
| Webhook Call Simulator | ✅ Done |
| Real phone number provisioning (API) | ✅ Done |
| SMS follow-up after call | ✅ Done |
| Voicemail recording + storage | ✅ Done |

---

## Environment Variables Required

```
PORT=3000
APP_URL=https://your-domain.com
ANTHROPIC_API_KEY=sk-ant-...
SUPERADMIN_USER=superadmin
SUPERADMIN_PASS=SuperAdmin2024!
PORTAL_SECRET=your-jwt-secret
```

Per-clinic (stored in DB, set via Super Admin UI):
- `twilio_sid` — Twilio Account SID
- `twilio_token` — Twilio Auth Token
- `twilio_phone` — Twilio phone number (E.164 format)
- `transfer_phone` — Human transfer number for live call routing
- `twilio_validate` — Enable Twilio signature validation (boolean)

---

## Key URLs (local)

| URL | Description |
|---|---|
| `http://localhost:3000/superadmin/` | Super Admin panel |
| `http://localhost:3000/admin/:slug` | Per-clinic admin dashboard |
| `http://localhost:3000/portal/:slug` | Client portal login |
| `http://localhost:3000/webhook/:slug/voice` | Twilio inbound webhook |
| `http://localhost:3000/webhook/:slug/gather` | Twilio speech gather |
| `http://localhost:3000/webhook/:slug/status` | Twilio status callback |

---

## Phase 9 — Suggested Next Steps

### High Priority
1. **Appointment reminder SMS** — `node-cron` job fires 24h and 1h before each appointment's `preferred_date`/`preferred_time`. Requires: `node-cron` dependency, `reminders_sent` flag on appointments, scheduler started in `server.js`.
2. **Voicemail playback in Super Admin** — Recording URL is stored but the call detail modal has no player. Add an `<audio>` element or a `/superadmin/api/calls/:id/recording` proxy endpoint (Twilio recording URLs require auth; the proxy handles that transparently).
3. **Escalation email on emergency** — When `emergency_detected = 1`, immediately email the clinic's `contact_email`. Currently no email fires on emergency — only the AI voice response.
4. **IVR Super Admin UI** — Add IVR enable/disable toggle and location editor to the clinic edit slide-over (Technical tab). Currently IVR config can only be set via DB or API.

### Medium Priority
5. **Per-location call tracking** — Add `selected_location` column to `calls` table so analytics can break down call volume by center (Hialeah vs Homestead vs Coral Gables).
6. **Appointment reminders per location** — When a patient selects a center via IVR, store the location on the appointment so reminder SMS says the correct address.
7. **Client portal enhancements** — View AI config (read-only tab), download call transcript as PDF (`pdfkit`), self-serve webhook URL update after provisioning a number.
8. **Call recording for all calls** — Add `record="record-from-answer"` to `<Dial>` with per-clinic `call_recording_enabled` flag.

### Lower Priority
9. **Multi-language IVR** — Spanish IVR option: if caller presses a language key first, serve the rest of the IVR in Spanish.
10. **Analytics export** — Download call analytics as CSV from the Analytics view.
11. **Production deployment guide** — `Dockerfile`, `docker-compose.yml`, nginx reverse proxy config, PM2 `ecosystem.config.js`, SSL/Let's Encrypt.
12. **Webhook signature validation enforcement** — Make Twilio signature validation the default for new clinics; current setting is opt-in per clinic.
13. **Rate limiting** — Add `express-rate-limit` on webhook routes to prevent abuse and runaway Twilio billing.

---

## File Structure (key files)

```
netcare-receptionist/
├── src/
│   ├── server.js               # Express app entry point
│   ├── database/
│   │   └── db.js               # SQLite schema, migrations, all DB helpers
│   ├── routes/
│   │   ├── superadmin.js       # Super Admin API + UI routes
│   │   ├── webhook.js          # Twilio voice webhook handlers
│   │   ├── admin.js            # Per-clinic admin dashboard routes
│   │   └── portal.js           # Client portal routes (JWT-protected)
│   ├── services/
│   │   ├── ai.js               # Claude integration, buildSystemPrompt, session mgmt
│   │   └── email.js            # Nodemailer appointment/message notifications
│   └── public/
│       ├── superadmin.html     # Super Admin SPA
│       ├── admin.html          # Per-clinic admin SPA
│       └── portal.html         # Client portal SPA
├── data/
│   └── netcare.db              # SQLite database
├── scripts/                    # One-time build/injection scripts
├── PROJECT_STATUS.md           # This file
└── package.json
```
