const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const path    = require('path');

const {
  getClinicBySlug, getClinicById,
  updateClinicTwilio, getClinicBilling,
  getStats, getCalls, getCallWithTranscript,
  getAppointments, updateAppointmentStatus,
  getDoctorMessages, updateDoctorMessageStatus,
  getWebRequests, updateWebRequestStatus,
} = require('../database/db');

// ── JWT helpers ───────────────────────────────────────────────────────────────

function jwtSecret(clinic) {
  return (process.env.PORTAL_SECRET || 'netcare-portal-secret') + '-' + clinic.id;
}

function signToken(clinic) {
  return jwt.sign(
    { clinicId: clinic.id, slug: clinic.slug },
    jwtSecret(clinic),
    { expiresIn: '8h' }
  );
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function portalAuth(req, res, next) {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  req.clinic = clinic;

  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const payload = jwt.verify(token, jwtSecret(clinic));
    if (payload.clinicId !== clinic.id) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Serve portal SPA ──────────────────────────────────────────────────────────

router.get('/:slug', (req, res) => {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic) return res.status(404).send('Clinic not found.');
  if (clinic.status === 'suspended' || clinic.status === 'cancelled') {
    return res.status(403).send('This account is currently inactive. Please contact NetCare support.');
  }
  res.sendFile(path.join(__dirname, '../public/portal.html'));
});

// ── Login ─────────────────────────────────────────────────────────────────────

router.post('/:slug/login', (req, res) => {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  if (clinic.status === 'suspended' || clinic.status === 'cancelled') {
    return res.status(403).json({ error: 'Account inactive. Contact NetCare support.' });
  }

  const { username, password } = req.body;
  if (username !== clinic.admin_user || password !== clinic.admin_pass) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken(clinic);
  res.json({
    token,
    clinic: {
      id:   clinic.id,
      slug: clinic.slug,
      name: clinic.name,
    },
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/:slug/api/stats', portalAuth, (req, res) => {
  try { res.json(getStats(req.clinic.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Calls ─────────────────────────────────────────────────────────────────────

router.get('/:slug/api/calls', portalAuth, (req, res) => {
  try {
    const { limit = 200, offset = 0, callType, startDate, endDate } = req.query;
    res.json(getCalls(+limit, +offset, { clinicId: req.clinic.id, callType, startDate, endDate }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:slug/api/calls/:id', portalAuth, (req, res) => {
  try {
    const call = getCallWithTranscript(+req.params.id);
    if (!call) return res.status(404).json({ error: 'Not found' });
    if (call.clinic_id !== req.clinic.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(call);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Appointments ──────────────────────────────────────────────────────────────

router.get('/:slug/api/appointments', portalAuth, (req, res) => {
  try {
    res.json(getAppointments(+req.query.limit || 100, req.clinic.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:slug/api/appointments/:id/status', portalAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled', 'synced'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  try {
    updateAppointmentStatus(+req.params.id, status, null, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Doctor Messages ───────────────────────────────────────────────────────────

router.get('/:slug/api/messages', portalAuth, (req, res) => {
  try {
    res.json(getDoctorMessages(+req.query.limit || 100, req.clinic.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:slug/api/messages/:id/status', portalAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'read', 'resolved'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  try {
    updateDoctorMessageStatus(+req.params.id, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Web Requests ──────────────────────────────────────────────────────────────

router.get('/:slug/api/web-requests', portalAuth, (req, res) => {
  try {
    res.json(getWebRequests(+req.query.limit || 100, req.clinic.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:slug/api/web-requests/:id/status', portalAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  try {
    updateWebRequestStatus(+req.params.id, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Telnyx config ─────────────────────────────────────────────────────────────

router.get('/:slug/api/telnyx', portalAuth, (req, res) => {
  const c      = req.clinic;
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const mask   = s => s && s.length > 8 ? s.slice(0, 4) + '••••••••' + s.slice(-4) : (s ? '••••••••' : null);
  const hasKey = !!(c.telnyx_api_key || process.env.TELNYX_API_KEY);

  res.json({
    configured:  !!(hasKey && c.telnyx_phone && process.env.APP_URL),
    apiKey:      mask(c.telnyx_api_key),
    phoneNumber: c.telnyx_phone || null,
    appUrl,
    webhookUrl:  `${appUrl}/telnyx/webhook`,
    checks: {
      hasApiKey:     hasKey,
      hasPhoneNumber:!!c.telnyx_phone,
      hasAppUrl:     !!process.env.APP_URL,
    },
  });
});

router.put('/:slug/api/telnyx', portalAuth, (req, res) => {
  const { telnyxApiKey, telnyxPhone } = req.body;
  try {
    updateClinic(req.clinic.id, { telnyxApiKey, telnyxPhone });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:slug/api/telnyx/test', portalAuth, async (req, res) => {
  const c      = req.clinic;
  const apiKey = c.telnyx_api_key || process.env.TELNYX_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'Telnyx API key not configured' });
  try {
    const r    = await fetch('https://api.telnyx.com/v2/phone_numbers?page[size]=1', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`Telnyx API returned ${r.status}`);
    res.json({ ok: true, message: 'Telnyx API key is valid' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Billing ───────────────────────────────────────────────────────────────────

router.get('/:slug/api/billing', portalAuth, (req, res) => {
  try {
    const billing = getClinicBilling(req.clinic.id);
    res.json(billing);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
