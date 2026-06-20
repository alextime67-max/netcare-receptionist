const express   = require('express');
const router    = express.Router();
const basicAuth = require('express-basic-auth');
const path      = require('path');
const fs        = require('fs');

const twilio = require('twilio');

const {
  getClinics, getClinicBySlug, getClinicById,
  createClinic, updateClinic, deleteClinic,
  getStats, getGlobalStats,
  getClinicAiConfig, updateClinicAiConfig,
  getAllCalls, getCallCount, getCallWithTranscript,
  getCallVolumeByDay, getCallAnalyticsSummary,
  db,
} = require('../database/db');

const { runTestMessage, getInitialGreeting, buildSystemPrompt, INDUSTRY_TEMPLATES, getActiveSessions } = require('../services/ai');

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

// ── Live stats (active call sessions) ────────────────────────────────────────

router.get('/api/stats/live', (_req, res) => {
  res.json({ activeSessions: getActiveSessions() });
});

// ── Global call log ───────────────────────────────────────────────────────────

router.get('/api/calls', (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit  || 100, 10), 500);
    const offset   = parseInt(req.query.offset || 0, 10);
    const filter   = {
      clinicId:  req.query.clinicId  || undefined,
      status:    req.query.status    || undefined,
      startDate: req.query.startDate || undefined,
      endDate:   req.query.endDate   || undefined,
    };
    const calls = getAllCalls(limit, offset, filter);
    const total = getCallCount(filter);
    res.json({ calls, total, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/calls/:id', (req, res) => {
  try {
    const detail = getCallWithTranscript(+req.params.id);
    if (!detail) return res.status(404).json({ error: 'Not found' });
    res.json(detail);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Twilio credential test ────────────────────────────────────────────────────

router.post('/api/clinics/:id/twilio/test', async (req, res) => {
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });

    const sid   = req.body.twilioSid   || clinic.twilio_sid;
    const token = req.body.twilioToken || clinic.twilio_token;
    const phone = req.body.twilioPhone || clinic.twilio_phone;

    if (!sid || !token)
      return res.status(400).json({ ok: false, error: 'Twilio SID and Auth Token are required' });

    const client = twilio(sid, token);

    // Validate account
    const account = await client.api.accounts(sid).fetch();

    // Look up the phone number in the account
    let phoneInfo = null;
    if (phone) {
      try {
        const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: phone, limit: 1 });
        phoneInfo = numbers[0] || null;
      } catch { /* phone not found in account */ }
    }

    res.json({
      ok: true,
      account: {
        status:       account.status,
        friendlyName: account.friendlyName,
        type:         account.type,
      },
      phoneNumber: phoneInfo ? {
        friendlyName:  phoneInfo.friendlyName,
        phoneNumber:   phoneInfo.phoneNumber,
        capabilities:  phoneInfo.capabilities,
        voiceUrl:      phoneInfo.voiceUrl,
      } : (phone ? { error: 'Phone number not found in this Twilio account' } : null),
    });
  } catch (e) {
    const msg = e.message.includes('authenticate') || e.status === 401
      ? 'Invalid Twilio credentials — check your Account SID and Auth Token'
      : e.message;
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── Initiate a real test call via Twilio ──────────────────────────────────────

router.post('/api/clinics/:id/twilio/call', async (req, res) => {
  try {
    const { testPhone } = req.body;
    if (!testPhone) return res.status(400).json({ error: 'testPhone is required' });

    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    if (!clinic.twilio_sid || !clinic.twilio_token || !clinic.twilio_phone)
      return res.status(400).json({ error: 'Twilio credentials not fully configured for this clinic' });

    const appUrl     = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const webhookUrl = `${appUrl}/webhook/${clinic.slug}/voice`;
    const statusUrl  = `${appUrl}/webhook/${clinic.slug}/status`;

    const client = twilio(clinic.twilio_sid, clinic.twilio_token);
    const call   = await client.calls.create({
      to:                   testPhone,
      from:                 clinic.twilio_phone,
      url:                  webhookUrl,
      statusCallback:       statusUrl,
      statusCallbackMethod: 'POST',
    });

    res.json({ ok: true, callSid: call.sid, status: call.status });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Industry templates list ───────────────────────────────────────────────────

router.get('/api/ai/templates', (_req, res) => {
  const list = Object.entries(INDUSTRY_TEMPLATES).map(([key, t]) => ({
    key,
    label:       t.label,
    description: t.description,
    tone:        t.tone,
    extraRules:  t.extraRules,
  }));
  res.json(list);
});

// ── Prompt preview (stateless — accepts clinic-like object, returns built prompt) ──

router.post('/api/ai/preview', (req, res) => {
  try {
    const prompt = buildSystemPrompt(req.body);
    res.json({ prompt, length: prompt.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────

router.get('/api/analytics', (req, res) => {
  try {
    const clinicId = req.query.clinicId ? +req.query.clinicId : null;
    const days     = Math.min(parseInt(req.query.days || '30', 10), 90);
    res.json({
      dailyVolume: getCallVolumeByDay(clinicId, days),
      summary:     getCallAnalyticsSummary(clinicId),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────

router.get('/api/health', async (req, res) => {
  const checks = {};

  // Database
  try {
    db.prepare('SELECT 1').get();
    checks.database = { status: 'ok' };
  } catch (e) {
    checks.database = { status: 'error', message: e.message };
  }

  // Anthropic API key
  checks.anthropicKey = { status: process.env.ANTHROPIC_API_KEY ? 'ok' : 'missing' };

  // App URL
  checks.appUrl = {
    status: process.env.APP_URL ? 'ok' : 'warning',
    value:  process.env.APP_URL || '(not set — using localhost)',
  };

  // Twilio — count clinics fully configured
  const clinics = getClinics();
  const twilioReady = clinics.filter(c => c.twilio_sid && c.twilio_token && c.twilio_phone).length;
  checks.twilio = {
    status:            twilioReady > 0 ? 'ok' : 'warning',
    clinicsConfigured: twilioReady,
    totalClinics:      clinics.length,
  };

  // Portal secret
  checks.portalSecret = { status: process.env.PORTAL_SECRET ? 'ok' : 'warning' };

  const healthy = checks.database.status === 'ok' && checks.anthropicKey.status === 'ok';
  res.status(healthy ? 200 : 503).json({
    status:    healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ── Twilio phone number provisioning ─────────────────────────────────────────

router.get('/api/clinics/:id/twilio/numbers', async (req, res) => {
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    if (!clinic.twilio_sid || !clinic.twilio_token)
      return res.status(400).json({ error: 'Twilio credentials not configured' });

    const { areaCode, country = 'US', capabilities = 'voice' } = req.query;
    const client = twilio(clinic.twilio_sid, clinic.twilio_token);

    const searchOpts = { limit: 20, voiceEnabled: true };
    if (areaCode) searchOpts.areaCode = areaCode;
    if (capabilities === 'sms') searchOpts.smsEnabled = true;

    const numbers = await client.availablePhoneNumbers(country).local.list(searchOpts);

    res.json({
      numbers: numbers.map(n => ({
        phoneNumber:  n.phoneNumber,
        friendlyName: n.friendlyName,
        locality:     n.locality,
        region:       n.region,
        postalCode:   n.postalCode,
        capabilities: n.capabilities,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/clinics/:id/twilio/provision', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber is required' });

    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    if (!clinic.twilio_sid || !clinic.twilio_token)
      return res.status(400).json({ error: 'Twilio credentials not configured' });

    const appUrl     = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const voiceUrl   = `${appUrl}/webhook/${clinic.slug}/voice`;
    const statusUrl  = `${appUrl}/webhook/${clinic.slug}/status`;

    const client = twilio(clinic.twilio_sid, clinic.twilio_token);
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl,
      voiceMethod:          'POST',
      statusCallback:       statusUrl,
      statusCallbackMethod: 'POST',
      friendlyName:         `NetCare — ${clinic.name}`,
    });

    // Persist the number on the clinic
    updateClinic(+req.params.id, { twilioPhone: purchased.phoneNumber });

    console.log(`[Provisioning] Purchased ${purchased.phoneNumber} for clinic ${clinic.slug}`);
    res.json({
      ok:          true,
      phoneNumber: purchased.phoneNumber,
      sid:         purchased.sid,
      voiceUrl:    purchased.voiceUrl,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/clinics/:id/twilio/configure-webhook', async (req, res) => {
  try {
    const clinic = getClinicById(+req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    if (!clinic.twilio_sid || !clinic.twilio_token || !clinic.twilio_phone)
      return res.status(400).json({ error: 'Twilio credentials and phone number required' });

    const appUrl    = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const voiceUrl  = `${appUrl}/webhook/${clinic.slug}/voice`;
    const statusUrl = `${appUrl}/webhook/${clinic.slug}/status`;

    const client  = twilio(clinic.twilio_sid, clinic.twilio_token);
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: clinic.twilio_phone, limit: 1 });
    if (!numbers.length) return res.status(404).json({ error: 'Phone number not found in this Twilio account' });

    await client.incomingPhoneNumbers(numbers[0].sid).update({
      voiceUrl,
      voiceMethod:          'POST',
      statusCallback:       statusUrl,
      statusCallbackMethod: 'POST',
    });

    res.json({ ok: true, voiceUrl, statusUrl });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
