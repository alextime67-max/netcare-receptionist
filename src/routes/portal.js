const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const path    = require('path');
const twilio  = require('twilio');

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

// ── Twilio config ─────────────────────────────────────────────────────────────

router.get('/:slug/api/twilio', portalAuth, (req, res) => {
  const c      = req.clinic;
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const mask   = s => s && s.length > 8 ? s.slice(0, 4) + '••••••••' + s.slice(-4) : (s ? '••••••••' : null);

  res.json({
    configured:     !!(c.twilio_sid && c.twilio_token && c.twilio_phone && process.env.APP_URL),
    accountSid:     mask(c.twilio_sid),
    authToken:      mask(c.twilio_token),
    phoneNumber:    c.twilio_phone || null,
    validateEnabled:!!c.twilio_validate,
    appUrl,
    webhookVoice:   `${appUrl}/webhook/${c.slug}/voice`,
    webhookStatus:  `${appUrl}/webhook/${c.slug}/status`,
    checks: {
      hasAccountSid:   !!c.twilio_sid,
      hasAuthToken:    !!c.twilio_token,
      hasPhoneNumber:  !!c.twilio_phone,
      hasAppUrl:       !!process.env.APP_URL,
      validateEnabled: !!c.twilio_validate,
    },
  });
});

router.put('/:slug/api/twilio', portalAuth, (req, res) => {
  const { twilioSid, twilioToken, twilioPhone, twilioValidate } = req.body;
  try {
    updateClinicTwilio(req.clinic.id, { twilioSid, twilioToken, twilioPhone, twilioValidate });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:slug/api/twilio/test', portalAuth, async (req, res) => {
  const c = req.clinic;
  if (!c.twilio_sid || !c.twilio_token) {
    return res.json({ ok: false, error: 'Twilio credentials not configured for this clinic' });
  }
  try {
    const client  = twilio(c.twilio_sid, c.twilio_token);
    const account = await client.api.accounts(c.twilio_sid).fetch();

    let phoneInfo = null;
    if (c.twilio_phone) {
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: c.twilio_phone, limit: 1 });
      phoneInfo = numbers.length
        ? { found: true, friendlyName: numbers[0].friendlyName, voiceUrl: numbers[0].voiceUrl || null, capabilities: numbers[0].capabilities }
        : { found: false };
    }

    res.json({ ok: true, accountName: account.friendlyName, accountStatus: account.status, phoneInfo });
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
