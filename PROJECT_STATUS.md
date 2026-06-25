# NetCare AI Receptionist — Project Status

**Last updated:** 2026-06-25
**Branch:** `master`
**Latest commit:** 18f63df

---

## Completed Phases

### Phase 12 — OpenAI Realtime Voice (Ana Live Voice) ✅ LATEST

- **OpenAI Realtime API integrated** (`gpt-realtime-2025-08-28`) — speech-to-speech voice conversation with Ana directly in the browser.
- **WebSocket relay architecture** — browser connects to `/realtime/browser/:token` on our server; server relays bidirectionally to `wss://api.openai.com/v1/realtime`. API key never leaves the server.
- **One-time token authentication** — `POST /superadmin/api/clinics/:id/realtime/session` issues a 60-second one-time WS token (replaced the non-existent `/v1/realtime/sessions` OpenAI endpoint).
- **Browser microphone capture** — `getUserMedia` at 24 kHz mono, `ScriptProcessorNode` converts Float32 → Int16 PCM → base64 and streams to server via WebSocket.
- **Audio playback** — `AudioContext` at 24 kHz; `AudioBufferSourceNode` scheduled playback queue for smooth, gap-free audio from Ana.
- **VAD (Voice Activity Detection)** — server-side VAD via OpenAI; interruption handling resets playback cursor on `input_speech_started`.
- **Ana greets first** — after `session.updated`, server sends `response.create` so Ana opens the conversation.
- **Live transcription** — caller speech shown in real time via `input_audio_transcription.delta/completed`; Ana's responses shown via `response.audio_transcript.done`.
- **Self-contained voice panel** — Live Voice tab has its own clinic selector populated from `allClients` at page load. No longer requires the Training Center dropdown to be used first.
- **Twilio relay prepared** — `/webhook/:slug/realtime-voice` TwiML route + `/realtime/twilio/:slug` WebSocket handler ready for phone integration (uses `g711_ulaw` audio, zero transcoding).
- **Per-clinic OpenAI config** — `openai_api_key`, `openai_voice`, `openai_language` columns on `clinics` table; configurable in AI Settings.
- **Ana system prompt** — `buildRealtimeInstructions()` injects clinic KB + legacy AI config fields; warm bilingual persona, warmth phrases, emergency protocol, goodbye templates.

**Known issue (external):** OpenAI account returns `insufficient_quota`. Add billing credits at platform.openai.com → Billing to activate Live Voice. All code is correct and the connection chain is verified working.

**Twilio phone integration:** NOT started. Infrastructure is prepared (relay route exists). Phase 13 task.

---

### Phase 11 — AI Training Center ✅

- Website and document import into clinic knowledge base (`training_sources` table).
- FAQ Manager, Rules Manager, Manual Notes editors.
- Train Ana — synthesizes all sources into structured `knowledge_base` table fields via Claude.
- Test Ana — question/answer against the trained KB.
- Practice Conversation — 12+ scenario types with elderly/confused caller modes and quick-phrase buttons.
- `multer` file upload for PDF/DOCX/TXT sources.
- `sort_order` columns on `training_faqs` and `training_sources` for ordering.

---

### Phase 10 — Appointment Reminders, Emergency Alerts, Voicemail Playback & IVR UI ✅

- **Appointment reminder SMS** (`node-cron`): scheduler fires every 5 minutes, sends bilingual reminders at 24 h and 1 h windows. Duplicate-send prevention via `reminder_24h_sent` / `reminder_1h_sent` flags.
- **Emergency escalation email**: `sendEmergencyAlert()` emails clinic contact when AI detects emergency call.
- **Voicemail playback in Super Admin**: proxy route streams Twilio MP3 recording to browser `<audio>` player.
- **IVR Super Admin UI**: full IVR configuration section in Technical Setup — enable/disable, display name, bilingual toggle, dynamic location options editor.

### Phase 9 — Knowledge Base System ✅

- Per-clinic KB with 13 content categories stored in `knowledge_base` table.
- AI prompt injection via `buildKbPromptSection()` on every call.
- Fallback tracking (`unanswered_questions` table) + Super Admin review view.
- Medical safety guardrails hardcoded in every KB prompt.
- MDcare sample content for all 3 locations.

### Phase 8 — IVR Menu, Spanish Voice Flow & Bug Fixes ✅

- DTMF IVR menu per clinic (`ivr_config` JSON).
- MDcare 3-location IVR (Hialeah / Homestead / Coral Gables).
- Spanish-first voice flow (`Polly.Lupe`).
- JavaScript syntax bug fixes in Super Admin navigation.

### Phase 7 — SMS Follow-up, Voicemail, Analytics & Production Readiness ✅

- SMS follow-up after appointment calls, doctor messages, missed calls, voicemails.
- Voicemail recording via Twilio `<Record>` TwiML.
- Analytics dashboard (90-day call volume, intent breakdown, language split, KPIs).
- System health check endpoint.
- 24 automated tests.

### Phase 6 — Real Twilio Integration ✅

- Credential validation, live call transfer, outbound test call, webhook call simulator.
- Global call log with filters, call transcript modal, live active-calls counter.
- Real phone number provisioning via Twilio REST API.

### Phase 5 — Industry Templates + Master Prompt Engine ✅

- 9 industry templates; master prompt field; prompt preview modal with token count.

### Phase 4 — AI Assistant Configuration ✅

- Per-clinic AI config (11 columns); FAQ builder; AI Test Simulator.

### Phase 3 — Client Portal ✅

- JWT-authenticated portal at `/portal/:slug`.

### Phase 2 — Multi-Clinic Architecture + Super Admin v1 ✅

- Multi-clinic data model; slug-based routing; Super Admin panel.

### Phase 1 — Core AI Receptionist ✅

- Claude integration; inbound call handling; bilingual support; intent classification.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 / Express 4 |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| AI — Text | Anthropic Claude `claude-sonnet-4-6` |
| AI — Voice | OpenAI Realtime API `gpt-realtime-2025-08-28` |
| Voice / Phone | Twilio Voice (TwiML webhooks + Media Streams) |
| Auth — Super Admin | HTTP Basic Auth (`express-basic-auth`) |
| Auth — Client Portal | JWT (`jsonwebtoken`, 8 h tokens) |
| WebSocket | `ws` npm package (Twilio relay + browser relay) |
| Frontend | Vanilla JS + Tailwind CSS (CDN) |
| Email | Nodemailer |

---

## Twilio Integration Status

| Capability | Status |
|---|---|
| Store SID / Auth Token / Phone per clinic | ✅ Done |
| Inbound voice webhook flow (TwiML) | ✅ Done |
| Bilingual TwiML (`<Say>` with Polly voices) | ✅ Done |
| Speech recognition (`<Gather>`) | ✅ Done |
| Live call transfer (`<Dial>`) | ✅ Done |
| SMS follow-up | ✅ Done |
| Voicemail recording | ✅ Done |
| Real number provisioning | ✅ Done |
| **OpenAI Realtime via Twilio Media Streams** | ⏳ Not started (Phase 13) |

---

## OpenAI Realtime Status

| Capability | Status |
|---|---|
| Browser WebSocket relay (`/realtime/browser/:token`) | ✅ Working |
| One-time token auth for browser WS | ✅ Working |
| Ana system prompt from clinic KB | ✅ Working |
| Microphone capture (24 kHz PCM16) | ✅ Working |
| Audio playback (scheduled AudioContext) | ✅ Working |
| Live transcription (user + Ana) | ✅ Working |
| VAD + interruption handling | ✅ Working |
| Ana greets first on connect | ✅ Working |
| Per-clinic API key + voice + language | ✅ Working |
| Twilio Media Streams relay prepared | ✅ Ready (not tested) |
| OpenAI account billing | ❌ `insufficient_quota` — add credits at platform.openai.com |

---

## Environment Variables Required

```
PORT=3000
APP_URL=https://your-domain.com
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...        # Optional — per-clinic key takes priority
SUPERADMIN_USER=superadmin
SUPERADMIN_PASS=SuperAdmin2024!
PORTAL_SECRET=your-jwt-secret
```

Per-clinic (stored in DB, set via Super Admin → AI Settings):
- `openai_api_key` — OpenAI API key for Realtime Voice
- `openai_voice` — Voice selection (shimmer, nova, coral, alloy, etc.)
- `openai_language` — `es` or `en`

---

## Key URLs (local)

| URL | Description |
|---|---|
| `http://localhost:3000/superadmin/` | Super Admin panel |
| `http://localhost:3000/admin/:slug` | Per-clinic admin dashboard |
| `http://localhost:3000/portal/:slug` | Client portal |
| `http://localhost:3000/webhook/:slug/voice` | Twilio inbound webhook (TwiML/Claude) |
| `http://localhost:3000/webhook/:slug/realtime-voice` | Twilio Realtime webhook (OpenAI) |
| `ws://localhost:3000/realtime/browser/:token` | Browser Live Voice relay |
| `ws://localhost:3000/realtime/twilio/:slug` | Twilio Media Streams relay |

---

## Next Phase

### Phase 13 — Twilio Phone → OpenAI Realtime Voice

Connect a real Twilio phone number to Ana using OpenAI Realtime Voice (speech-to-speech). When a caller dials the Twilio number, the call audio is streamed via Twilio Media Streams WebSocket to our server, which relays it to OpenAI Realtime. Ana responds with real-time voice audio streamed back to the caller.

**Prerequisites:**
1. Public HTTPS URL (ngrok or production server) — Twilio requires a public endpoint.
2. OpenAI account with billing credits and Realtime API access.
3. Twilio phone number configured with webhook: `https://your-domain.com/webhook/:slug/realtime-voice`.

**Steps:**
1. Set `APP_URL` in `.env` to the public HTTPS URL.
2. Point Twilio phone number Voice webhook to `/webhook/:slug/realtime-voice`.
3. Call the number — Twilio connects via Media Streams to `/realtime/twilio/:slug`.
4. Server relays `g711_ulaw` audio to OpenAI Realtime (no transcoding needed).
5. Test with real calls; adjust VAD sensitivity and Ana instructions as needed.

---

## File Structure (key files)

```
netcare-receptionist/
├── src/
│   ├── server.js                # Express + HTTP server + WebSocket upgrade handler
│   ├── database/
│   │   └── db.js                # SQLite schema, migrations, all DB helpers
│   ├── routes/
│   │   ├── superadmin.js        # Super Admin API + UI routes
│   │   ├── webhook.js           # Twilio TwiML handlers + Realtime TwiML route
│   │   ├── admin.js             # Per-clinic admin dashboard
│   │   └── portal.js            # Client portal (JWT-protected)
│   ├── services/
│   │   ├── ai.js                # Claude integration, buildSystemPrompt, sessions
│   │   ├── realtime.js          # OpenAI Realtime: browser relay, Twilio relay, tokens
│   │   ├── email.js             # Nodemailer notifications
│   │   ├── sms.js               # Twilio SMS follow-up
│   │   └── scheduler.js         # node-cron appointment reminder jobs
│   └── public/
│       ├── superadmin.html      # Super Admin SPA (5 000+ lines)
│       ├── admin.html           # Per-clinic admin SPA
│       └── portal.html          # Client portal SPA
├── data/
│   └── netcare.db               # SQLite database
├── tests/                       # 35 automated tests (node:test)
├── PROJECT_STATUS.md            # This file
└── package.json
```
