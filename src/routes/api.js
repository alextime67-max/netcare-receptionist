const express   = require('express');
const router    = express.Router();
const basicAuth = require('express-basic-auth');
const {
  getClinicBySlug,
  getCalls, getCallWithTranscript, getStats,
  getAppointments, getDoctorMessages,
  updateAppointmentStatus, updateDoctorMessageStatus,
  getWebRequests, updateWebRequestStatus,
} = require('../database/db');

// ── Per-clinic auth middleware ────────────────────────────────────────────────

function clinicAuth(req, res, next) {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  req.clinic = clinic;

  const check = basicAuth({
    users:     { [clinic.admin_user]: clinic.admin_pass },
    challenge: true,
    realm:     `${clinic.name} Admin`,
  });
  check(req, res, next);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/:slug/stats', clinicAuth, (req, res) => {
  try { res.json(getStats(req.clinic.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Calls ─────────────────────────────────────────────────────────────────────

router.get('/:slug/calls', clinicAuth, (req, res) => {
  try {
    const { limit = 100, offset = 0, callType, startDate, endDate } = req.query;
    res.json(getCalls(+limit, +offset, { clinicId: req.clinic.id, callType, startDate, endDate }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:slug/calls/:id', clinicAuth, (req, res) => {
  try {
    const call = getCallWithTranscript(+req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.clinic_id !== req.clinic.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(call);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Appointments ──────────────────────────────────────────────────────────────

router.get('/:slug/appointments', clinicAuth, (req, res) => {
  try {
    res.json(getAppointments(+req.query.limit || 100, req.clinic.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:slug/appointments/:id/status', clinicAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled', 'synced'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  try {
    updateAppointmentStatus(+req.params.id, status, null, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Doctor Messages ───────────────────────────────────────────────────────────

router.get('/:slug/messages', clinicAuth, (req, res) => {
  try {
    res.json(getDoctorMessages(+req.query.limit || 100, req.clinic.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:slug/messages/:id/status', clinicAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'read', 'resolved'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  try {
    updateDoctorMessageStatus(+req.params.id, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Web Requests ──────────────────────────────────────────────────────────────

router.get('/:slug/web-requests', clinicAuth, (req, res) => {
  try {
    res.json(getWebRequests(+req.query.limit || 100, req.clinic.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:slug/web-requests/:id/status', clinicAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  try {
    updateWebRequestStatus(+req.params.id, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Twilio config (per-clinic) ────────────────────────────────────────────────

router.get('/:slug/config/twilio', clinicAuth, (req, res) => {
  const c      = req.clinic;
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const mask   = s => s && s.length > 8 ? s.slice(0, 4) + '••••••••' + s.slice(-4) : (s ? '••••••••' : '');

  res.json({
    configured:    !!(c.twilio_sid && c.twilio_token && c.twilio_phone && process.env.APP_URL),
    accountSid:    mask(c.twilio_sid),
    authToken:     mask(c.twilio_token),
    phoneNumber:   c.twilio_phone || null,
    appUrl,
    webhookVoice:  `${appUrl}/webhook/${c.slug}/voice`,
    webhookStatus: `${appUrl}/webhook/${c.slug}/status`,
    checks: {
      hasAccountSid:   !!c.twilio_sid,
      hasAuthToken:    !!c.twilio_token,
      hasPhoneNumber:  !!c.twilio_phone,
      hasAppUrl:       !!process.env.APP_URL,
      validateEnabled: !!c.twilio_validate,
    },
  });
});

router.post('/:slug/config/test-twilio', clinicAuth, async (_req, res) => {
  res.json({ ok: false, error: 'Twilio has been replaced by Telnyx. Configure Telnyx in the Super Admin panel.' });
});

module.exports = router;
