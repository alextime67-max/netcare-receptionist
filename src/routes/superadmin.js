const express   = require('express');
const router    = express.Router();
const basicAuth = require('express-basic-auth');
const path      = require('path');
const fs        = require('fs');

const {
  getClinics, getClinicBySlug, getClinicById,
  createClinic, updateClinic, deleteClinic,
  getStats, getGlobalStats,
  getClinicAiConfig, updateClinicAiConfig,
} = require('../database/db');

const { runTestMessage, getInitialGreeting } = require('../services/ai');

const SA_USER = process.env.SUPERADMIN_USER || 'superadmin';
const SA_PASS = process.env.SUPERADMIN_PASS || 'SuperAdmin2024!';

router.use(basicAuth({ users: { [SA_USER]: SA_PASS }, challenge: true, realm: 'NetCare Phone Admin' }));

// ── UI ────────────────────────────────────────────────────────────────────────

router.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/superadmin.html'));
});

// ── Global stats ──────────────────────────────────────────────────────────────

router.get('/api/stats', (_req, res) => {
  try { res.json(getGlobalStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clinic list (with per-clinic stats) ───────────────────────────────────────

router.get('/api/clinics', (_req, res) => {
  try {
    const clinics = getClinics();
    const appUrl  = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const result  = clinics.map(c => ({
      ...c,
      twilio_token:  c.twilio_token  ? '••••••••' : null,
      gmail_app_pass:c.gmail_app_pass? '••••••••' : null,
      smtp_pass:     c.smtp_pass     ? '••••••••' : null,
      admin_pass:    c.admin_pass    ? '••••••••' : null,
      stats:         getStats(c.id),
      dashboardUrl:  `${appUrl}/admin/${c.slug}`,
      webhookUrl:    `${appUrl}/webhook/${c.slug}/voice`,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single clinic (full detail, unmasked for editing) ─────────────────────────

router.get('/api/clinics/:id', (req, res) => {
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Not found' });
    res.json(clinic);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/api/clinics', (req, res) => {
  const { slug, name } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' });
  if (!/^[a-z0-9-]+$/.test(slug))
    return res.status(400).json({ error: 'slug must be lowercase letters, numbers, and hyphens only' });
  if (getClinicBySlug(slug))
    return res.status(409).json({ error: 'A client with this slug already exists' });
  try {
    const id = createClinic(req.body);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/api/clinics/:id', (req, res) => {
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Not found' });

    const data = { ...req.body };

    // Auto-set timestamps when status changes
    if (data.status === 'suspended' && clinic.status !== 'suspended') {
      data.suspendedAt = new Date().toISOString();
    }
    if (data.status === 'active' && clinic.status !== 'active') {
      data.onboardedAt = clinic.onboarded_at || new Date().toISOString();
      data.suspendedAt = null;
    }

    updateClinic(+req.params.id, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quick status change ───────────────────────────────────────────────────────

router.patch('/api/clinics/:id/status', (req, res) => {
  const { status } = req.body;
  const allowed = ['active', 'suspended', 'cancelled'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status must be: ${allowed.join(', ')}` });
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Not found' });
    const data = { status };
    if (status === 'suspended') data.suspendedAt = new Date().toISOString();
    if (status === 'active')    { data.onboardedAt = clinic.onboarded_at || new Date().toISOString(); data.suspendedAt = null; }
    updateClinic(+req.params.id, data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quick payment status ──────────────────────────────────────────────────────

router.patch('/api/clinics/:id/payment', (req, res) => {
  const { paymentStatus } = req.body;
  const allowed = ['trial', 'current', 'overdue', 'failed'];
  if (!allowed.includes(paymentStatus))
    return res.status(400).json({ error: `paymentStatus must be: ${allowed.join(', ')}` });
  try {
    updateClinic(+req.params.id, { paymentStatus });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI config ─────────────────────────────────────────────────────────────────

router.get('/api/clinics/:id/ai', (req, res) => {
  try {
    const cfg = getClinicAiConfig(+req.params.id);
    if (!cfg) return res.status(404).json({ error: 'Not found' });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api/clinics/:id/ai', (req, res) => {
  try {
    if (!getClinicById(+req.params.id)) return res.status(404).json({ error: 'Not found' });
    updateClinicAiConfig(+req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/clinics/:id/ai/test', async (req, res) => {
  try {
    const clinic = getClinicAiConfig(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });

    const { messages = [], userMessage } = req.body;

    // Special case: start conversation — return the initial greeting without calling Claude
    if (userMessage === '__start__') {
      const greeting = getInitialGreeting(clinic);
      return res.json({
        speak:           greeting,
        language:        'en',
        intent:          'greeting',
        complete:        false,
        emergencyDetected: false,
        updatedMessages: [{ role: 'assistant', content: greeting }],
      });
    }

    if (!userMessage || !userMessage.trim()) {
      return res.status(400).json({ error: 'userMessage is required' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
    }

    const result = await runTestMessage(clinic, messages, userMessage);
    res.json(result);
  } catch (e) {
    console.error('[AI Test]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete('/api/clinics/:id', (req, res) => {
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Not found' });
    deleteClinic(+req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
