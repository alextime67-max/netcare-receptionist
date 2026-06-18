const express    = require('express');
const router     = express.Router();
const basicAuth  = require('express-basic-auth');
const twilio     = require('twilio');

const {
  getCalls, getCallWithTranscript, getStats,
  getAppointments, getDoctorMessages,
} = require('../database/db');

const authMiddleware = basicAuth({
  users:     { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'NetCare2024!' },
  challenge: true,
  realm:     'NetCare API',
});

router.use(authMiddleware);

router.get('/stats', (req, res) => {
  try {
    res.json(getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/calls', (req, res) => {
  try {
    const { limit = 100, offset = 0, callType, startDate, endDate } = req.query;
    res.json(getCalls(+limit, +offset, { callType, startDate, endDate }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/calls/:id', (req, res) => {
  try {
    const call = getCallWithTranscript(+req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    res.json(call);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/appointments', (req, res) => {
  try {
    res.json(getAppointments(+req.query.limit || 50));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/messages', (req, res) => {
  try {
    res.json(getDoctorMessages(+req.query.limit || 50));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Twilio configuration ───────────────────────────────────────────────────────

router.get('/config/twilio', (req, res) => {
  const sid    = process.env.TWILIO_ACCOUNT_SID  || '';
  const token  = process.env.TWILIO_AUTH_TOKEN   || '';
  const phone  = process.env.TWILIO_PHONE_NUMBER || '';
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

  const mask = s => s.length > 8 ? s.slice(0, 4) + '••••••••' + s.slice(-4) : (s ? '••••••••' : '');

  res.json({
    configured:      !!(sid && token && phone && process.env.APP_URL),
    accountSid:      mask(sid),
    authToken:       mask(token),
    phoneNumber:     phone || null,
    appUrl,
    webhookVoice:    `${appUrl}/webhook/voice`,
    webhookStatus:   `${appUrl}/webhook/status`,
    checks: {
      hasAccountSid:   !!sid,
      hasAuthToken:    !!token,
      hasPhoneNumber:  !!phone,
      hasAppUrl:       !!process.env.APP_URL,
      validateEnabled: process.env.TWILIO_VALIDATE === 'true',
    },
  });
});

router.post('/config/test-twilio', async (req, res) => {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const phone = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token) {
    return res.json({ ok: false, error: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set in environment' });
  }

  try {
    const client  = twilio(sid, token);
    const account = await client.api.accounts(sid).fetch();

    let phoneInfo = null;
    if (phone) {
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: phone, limit: 1 });
      if (numbers.length) {
        phoneInfo = {
          found:        true,
          friendlyName: numbers[0].friendlyName,
          voiceUrl:     numbers[0].voiceUrl  || null,
          statusUrl:    numbers[0].statusCallback || null,
          capabilities: numbers[0].capabilities,
        };
      } else {
        phoneInfo = { found: false };
      }
    }

    res.json({
      ok:            true,
      accountName:   account.friendlyName,
      accountStatus: account.status,
      phoneInfo,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
