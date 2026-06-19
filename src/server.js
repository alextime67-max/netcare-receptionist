require('dotenv').config();
const express = require('express');
const path    = require('path');
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

app.listen(PORT, '0.0.0.0', () => {
  const base = process.env.APP_URL || `http://localhost:${PORT}`;
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║    NetCare AI Medical Receptionist  v2.0          ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`  Super Admin     : ${base}/superadmin`);
  console.log(`  Clinic Admin    : ${base}/admin/:slug`);
  console.log(`  Twilio webhook  : ${base}/webhook/:slug/voice`);
  console.log(`  Health check    : ${base}/`);
  console.log('');
});

module.exports = app;
