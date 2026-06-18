# NetCare AI Medical Receptionist

A bilingual (English / Spanish) AI-powered phone receptionist for NetCare clinic, built with Node.js, Express, Claude AI, Twilio, and SQLite.

---

## Features

- **Bilingual** — Auto-detects English or Spanish; responds entirely in the caller's language
- **Appointment requests** — Collects name, phone, preferred date/time, and reason
- **Doctor messages** — Captures message content and urgency (routine / urgent)
- **Emergency detection** — Immediately directs life-threatening callers to 911
- **Full call transcripts** — Every word stored in SQLite
- **Email notifications** — Staff alerted instantly on new appointments or messages
- **Admin dashboard** — Password-protected web UI to review all calls, transcripts, and records
- **Tebra integration stub** — DB columns and service layer ready for EHR sync
- **Deployable on Replit** — Config files included

---

## Architecture

```
Twilio (phone) ──POST──► /webhook/voice        ← initial TwiML greeting
                          /webhook/gather       ← speech → Claude AI → TwiML response
                          /webhook/no-input     ← handles silence / timeout
                          /webhook/status       ← tracks call duration

Claude AI (claude-sonnet-4-6)
  └─ Manages bilingual conversation state
  └─ Returns structured JSON with collected fields

SQLite (data/netcare.db)
  ├─ calls            — every inbound call
  ├─ transcripts      — every turn of conversation
  ├─ appointments     — scheduled appointment requests
  └─ doctor_messages  — messages for the doctor

Admin Dashboard (/admin)    ← basic-auth protected
API             (/api/*)    ← same auth, used by dashboard
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | `node --version` to verify |
| Twilio account | Free trial works — get a phone number |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) |
| SMTP / Gmail | For email notifications (optional but recommended) |

---

## Quick Start (Local)

### 1. Install dependencies

```bash
cd netcare-receptionist
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY and TWILIO credentials
```

### 3. Start the server

```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 4. Expose local server to the internet (for Twilio)

```bash
# Install ngrok if you don't have it: https://ngrok.com
ngrok http 3000
# Copy the HTTPS URL e.g. https://abc123.ngrok.io
```

### 5. Open the admin dashboard

```
http://localhost:3000/admin
Username: admin   (or value of ADMIN_USER in .env)
Password: NetCare2024!  (or value of ADMIN_PASS in .env)
```

---

## Twilio Configuration

1. Log in to [twilio.com/console](https://twilio.com/console)
2. Buy a phone number (Voice-capable)
3. Go to **Phone Numbers → Manage → Active Numbers → [your number]**
4. Under **Voice & Fax → A Call Comes In**:
   - Set to: **Webhook**
   - URL: `https://YOUR_URL/webhook/voice`
   - Method: `HTTP POST`
5. Under **Call Status Changes**:
   - URL: `https://YOUR_URL/webhook/status`
   - Method: `HTTP POST`
6. Save

> Replace `YOUR_URL` with your ngrok URL (local) or Replit URL (deployed).

---

## Deploying on Replit

### 1. Import the project

- Go to [replit.com](https://replit.com) and create a new Repl
- Choose **Import from GitHub** or upload the folder as a zip
- Select **Node.js** as the language

### 2. Set Secrets (Environment Variables)

In Replit's **Secrets** panel (the lock icon), add:

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `TWILIO_ACCOUNT_SID` | From Twilio Console |
| `TWILIO_AUTH_TOKEN` | From Twilio Console |
| `TWILIO_PHONE_NUMBER` | Your Twilio number (`+1...`) |
| `CLINIC_EMAIL` | Where notifications go |
| `GMAIL_USER` | Your Gmail address (for email) |
| `GMAIL_APP_PASSWORD` | Gmail App Password (16 chars) |
| `ADMIN_USER` | Dashboard username |
| `ADMIN_PASS` | Dashboard password |
| `APP_URL` | Your Replit URL (e.g. `https://netcare.yourusername.repl.co`) |

### 3. Run

Click **Run**. The console will print the admin URL and Twilio webhook URL.

### 4. Update Twilio

Set your Twilio phone number's webhook to `https://YOUR_REPLIT_URL/webhook/voice`.

> **Tip:** In Replit, go to **Deployments** to get a stable production URL that doesn't sleep.

---

## Email Setup Options

### Option A — Gmail (simplest)

1. Enable 2-Step Verification on your Google account
2. Go to **Google Account → Security → App Passwords**
3. Generate an app password for "Mail"
4. Set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`

### Option B — Generic SMTP (SendGrid, Mailgun, etc.)

```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=SG.your_key_here
```

> If neither is configured, the server logs notifications to the console instead of sending emails.

---

## API Reference

All API endpoints require HTTP Basic Auth (same credentials as admin dashboard).

| Method | Path | Description |
|---|---|---|
| GET | `/api/stats` | Dashboard stats |
| GET | `/api/calls` | List calls (supports `?callType=`, `?startDate=`, `?endDate=`) |
| GET | `/api/calls/:id` | Single call with full transcript |
| GET | `/api/appointments` | All appointments |
| GET | `/api/messages` | All doctor messages |

---

## Tebra (EHR) Integration — Future

The Tebra integration stub is at `src/services/tebra.js`. When you're ready to connect:

1. Obtain your **Tebra API Key**, **Practice Name**, username, and password
2. Add them to `.env`:
   ```env
   TEBRA_API_KEY=your_key
   TEBRA_PRACTICE_NAME=Your Practice
   TEBRA_USERNAME=admin@yourpractice.com
   TEBRA_PASSWORD=your_password
   TEBRA_DEFAULT_APPT_TYPE=1
   ```
3. Install the SOAP client: `npm install soap`
4. Implement the three functions in `tebra.js` (all have detailed TODO comments with the exact API call structure)
5. The DB already has `tebra_appointment_id` and `tebra_patient_id` columns ready

The `syncAppointmentToTebra()` function in `src/routes/webhook.js` is stubbed and can be un-commented once implemented.

---

## Project Structure

```
netcare-receptionist/
├── src/
│   ├── server.js                  # Express app entry point
│   ├── database/
│   │   └── db.js                  # SQLite schema + query helpers
│   ├── services/
│   │   ├── ai.js                  # Claude conversation engine
│   │   ├── email.js               # Nodemailer email notifications
│   │   └── tebra.js               # Tebra EHR integration stub
│   ├── routes/
│   │   ├── webhook.js             # Twilio TwiML webhooks
│   │   ├── admin.js               # Admin dashboard route
│   │   └── api.js                 # REST API for dashboard
│   └── public/
│       └── dashboard.html         # Single-page admin UI
├── data/                          # SQLite DB lives here (auto-created)
├── .env.example                   # Copy to .env and fill in
├── .replit                        # Replit run config
├── replit.nix                     # Replit Nix packages
├── package.json
└── README.md
```

---

## Security Notes

- Admin dashboard is protected with HTTP Basic Auth — use a strong password
- Webhook endpoints are public (required by Twilio) — consider adding Twilio signature validation for production
- No PHI is logged beyond what's necessary for call management
- Set `ADMIN_PASS` to a strong password before deploying

### Adding Twilio Signature Validation (recommended for production)

```javascript
// In src/routes/webhook.js, add at the top of each route:
const twilio = require('twilio');
const valid = twilio.validateRequest(
  process.env.TWILIO_AUTH_TOKEN,
  req.headers['x-twilio-signature'],
  `${process.env.APP_URL}${req.originalUrl}`,
  req.body
);
if (!valid) return res.status(403).send('Forbidden');
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Calls not connecting | Check Twilio webhook URL is set to `/webhook/voice` |
| AI not responding | Verify `ANTHROPIC_API_KEY` is set and valid |
| No emails received | Check SMTP/Gmail credentials; logs will show email content if transporter is null |
| Dashboard shows 401 | Check `ADMIN_USER` / `ADMIN_PASS` in .env match what you're entering |
| SQLite error on start | Ensure `data/` directory is writable |
| Replit URL changes | Update `APP_URL` secret and Twilio webhook URL |

---

## License

MIT — built for NetCare. Adapt freely.
