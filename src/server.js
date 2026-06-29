require('dotenv').config();
const express   = require('express');
const http      = require('http');
const path      = require('path');
const WebSocket = require('ws');
const { initDb } = require('./database/db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhook',     require('./routes/webhook'));
app.use('/admin',       require('./routes/admin'));
app.use('/superadmin',  require('./routes/superadmin'));
app.use('/portal',      require('./routes/portal'));
app.use('/api',         require('./routes/api'));
app.use('/public',      require('./routes/public'));

// Health check
app.get('/', (_req, res) => {
  res.json({
    service:   'NetCare AI Medical Receptionist',
    version:   '2.0.0',
    status:    'operational',
    timestamp: new Date().toISOString(),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb();

const { startScheduler } = require('./services/scheduler');
startScheduler();

// Create HTTP server so we can attach WebSocket for Twilio Media Streams
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const twilioMatch  = req.url?.match(/^\/realtime\/twilio\/([a-z0-9-]+)$/);
  const browserMatch = req.url?.match(/^\/realtime\/browser\/([a-f0-9]{32})$/);

  if (twilioMatch) {
    wss.handleUpgrade(req, socket, head, ws => {
      const { getClinicBySlug, getKnowledgeBase, getBusinessRules, getTrainingFaqs } = require('./database/db');
      const { createTwilioRelay } = require('./services/realtime');

      const clinic = getClinicBySlug(twilioMatch[1]);
      if (!clinic) { ws.close(1008, 'Clinic not found'); return; }

      const apiKey = clinic.openai_api_key || process.env.OPENAI_API_KEY;
      if (!apiKey) { ws.close(1008, 'OpenAI API key not configured'); return; }

      // Enrich kb with Training Center data so buildRealtimeInstructions includes rules + FAQs
      const kb = getKnowledgeBase(clinic.id) || {};
      kb.businessRules = getBusinessRules(clinic.id);
      kb.trainingFaqs  = getTrainingFaqs(clinic.id);

      createTwilioRelay(ws, apiKey, clinic, kb);
    });

  } else if (browserMatch) {
    wss.handleUpgrade(req, socket, head, ws => {
      const { getClinicAiConfig, getKnowledgeBase, getBusinessRules, getTrainingFaqs } = require('./database/db');
      const { consumeVoiceToken, createBrowserRelay } = require('./services/realtime');

      const clinicId = consumeVoiceToken(browserMatch[1]);
      if (!clinicId) { ws.close(1008, 'Invalid or expired token'); return; }

      const clinic = getClinicAiConfig(clinicId);
      if (!clinic) { ws.close(1008, 'Clinic not found'); return; }

      const apiKey = clinic.openai_api_key || process.env.OPENAI_API_KEY;
      if (!apiKey) { ws.close(1008, 'OpenAI API key not configured'); return; }

      // Enrich kb with Training Center data so buildRealtimeInstructions includes rules + FAQs
      const kb = getKnowledgeBase(clinicId) || {};
      kb.businessRules = getBusinessRules(clinicId);
      kb.trainingFaqs  = getTrainingFaqs(clinicId);

      createBrowserRelay(ws, apiKey, clinic, kb);
    });

  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const base = process.env.APP_URL || `http://localhost:${PORT}`;
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║    NetCare AI Medical Receptionist  v2.0          ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`  Super Admin     : ${base}/superadmin`);
  console.log(`  Clinic Admin    : ${base}/admin/:slug`);
  console.log(`  Client Portal   : ${base}/portal/:slug`);
  console.log(`  Twilio webhook  : ${base}/webhook/:slug/voice`);
  console.log(`  Realtime voice  : ${base}/webhook/:slug/realtime-voice`);
  console.log(`  Health check    : ${base}/`);
  console.log('');
});

module.exports = app;
