const express    = require('express');
const router     = express.Router();
const basicAuth  = require('express-basic-auth');

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

module.exports = router;
