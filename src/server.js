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
app.use('/telnyx',      require('./routes/telnyx'));
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

// Create HTTP server so we can attach WebSocket for Telnyx media relay
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const browserMatch = req.url?.match(/^\/realtime\/browser\/([a-f0-9]{32})$/);
  const mediaMatch   = req.url?.match(/^\/realtime\/media\/([a-f0-9]{32})$/);

  if (browserMatch) {
    // ── Live Voice browser chat (SuperAdmin) ──────────────────────────────────
    wss.handleUpgrade(req, socket, head, ws => {
      const { getClinicAiConfig, getKnowledgeBase, getBusinessRules, getTrainingFaqs } = require('./database/db');
      const { consumeVoiceToken, createBrowserRelay } = require('./services/realtime');

      const clinicId = consumeVoiceToken(browserMatch[1]);
      if (!clinicId) { ws.close(1008, 'Invalid or expired token'); return; }

      const clinic = getClinicAiConfig(clinicId);
      if (!clinic) { ws.close(1008, 'Clinic not found'); return; }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { ws.close(1008, 'Anthropic API key not configured'); return; }

      const kb = getKnowledgeBase(clinicId) || {};
      kb.businessRules = getBusinessRules(clinicId);
      kb.trainingFaqs  = getTrainingFaqs(clinicId);

      createBrowserRelay(ws, apiKey, clinic, kb);
    });

  } else if (mediaMatch) {
    // ── Deepgram media streaming (USE_STREAMING_STT=true) ────────────────────
    wss.handleUpgrade(req, socket, head, ws => {
      const { consumeMediaToken }    = require('./routes/telnyx');
      const { getTelnyxRelay }       = require('./services/realtime');
      const { createDeepgramRelay }  = require('./services/deepgram-relay');

      const tokenData = consumeMediaToken(mediaMatch[1]);
      if (!tokenData) {
        console.warn(`[MediaStream] Invalid or expired token ${mediaMatch[1].slice(0, 8)}… — closing`);
        ws.close(1008, 'Invalid or expired media token');
        return;
      }

      const relay = getTelnyxRelay(tokenData.callControlId);
      if (!relay) {
        console.warn(`[MediaStream] No active relay for ccid=…${tokenData.callControlId?.slice(-6)} — closing`);
        ws.close(1008, 'No active relay');
        return;
      }

      console.log(`[MediaStream] Deepgram relay creating  clinic=${tokenData.clinic.name || tokenData.clinic.slug}  ccid=…${tokenData.callControlId?.slice(-6)}`);
      const controller = createDeepgramRelay(ws, relay, tokenData.clinic, tokenData.kb || {});
      if (controller) relay.setDeepgramController(controller);
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
  console.log(`  Telnyx webhook  : ${base}/telnyx/webhook`);
  console.log(`  Health check    : ${base}/`);
  console.log('');
});

module.exports = app;
