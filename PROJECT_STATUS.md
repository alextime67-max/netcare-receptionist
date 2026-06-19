# NetCare AI Receptionist — Project Status

**Last updated:** 2026-06-19
**Branch:** `master`
**Latest commit:** See `git log --oneline -1`

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

### Phase 6 — Real Twilio Integration ✅ LATEST
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
| Real phone number provisioning (API) | ⬜ Phase 7 |
| SMS follow-up after call | ⬜ Phase 7 |
| Voicemail recording + transcription | ⬜ Phase 7 |

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

## Phase 7 — Suggested Next Steps

### High Priority
1. **SMS follow-up**: After a completed call, send patient a confirmation SMS via Twilio Messaging API (appointment details, doctor message receipt)
2. **Voicemail fallback**: If caller doesn't speak after 3 silence timeouts, offer to leave a voicemail; record with `<Record>`, store URL, transcribe via Whisper or Twilio transcription
3. **Real phone number provisioning**: Allow Super Admin to search and purchase Twilio phone numbers directly from the UI (`client.availablePhoneNumbers(...).list()`, `client.incomingPhoneNumbers.create()`)
4. **Webhook auto-configuration**: After assigning a Twilio number, automatically set its `voiceUrl` and `statusCallback` via Twilio REST API

### Medium Priority
5. **Appointment reminders**: Scheduled job (node-cron) that sends SMS reminders 24h and 1h before appointments
6. **Call recording**: Optional per-clinic recording with `<Record>` or `record="record-from-answer"` on `<Dial>`; store recording URL in calls table
7. **Analytics dashboard**: Charts for call volume by day/week, intent breakdown, language split, average duration
8. **Client portal enhancements**: Allow clients to update their own Twilio webhook URL, view AI config (read-only), download call transcripts as PDF

### Lower Priority
9. **Multi-language expansion**: Portuguese, French support (additional Polly voices + prompt localization)
10. **IVR menu**: Optional press-1/press-2 menu before AI takes over, for clinics that prefer structured routing
11. **Escalation email**: When emergency is detected, immediately email the clinic's emergency contact in addition to the existing AI response
12. **Production deployment guide**: Docker container, nginx reverse proxy, SSL, PM2 process management

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
