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

// ── Telnyx config (per-clinic) ────────────────────────────────────────────────

router.get('/:slug/config/telnyx', clinicAuth, (req, res) => {
  const c      = req.clinic;
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const mask   = s => s && s.length > 8 ? s.slice(0, 4) + '••••••••' + s.slice(-4) : (s ? '••••••••' : '');
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

router.post('/:slug/config/test-telnyx', clinicAuth, async (req, res) => {
  const c      = req.clinic;
  const apiKey = c.telnyx_api_key || process.env.TELNYX_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'Telnyx API key not configured' });
  try {
    const r = await fetch('https://api.telnyx.com/v2/phone_numbers?page[size]=1', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error(`Telnyx API returned ${r.status}`);
    res.json({ ok: true, message: 'Telnyx API key is valid' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
