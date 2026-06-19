const express = require('express');
const router  = express.Router();
const { saveWebRequest, getClinicBySlug } = require('../database/db');
const { sendWebRequestNotification } = require('../services/email');

router.post('/request', (req, res) => {
  const { firstName, lastName, phone, email, dateOfBirth,
          preferredDate, preferredTime, reason, language, clinicSlug } = req.body;

  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: 'First name, last name, and phone are required.' });
  }

  // Resolve clinic — fall back to first available slug from env
  const slug   = clinicSlug || process.env.DEFAULT_CLINIC_SLUG || 'netcare';
  const clinic = getClinicBySlug(slug);
  const clinicId = clinic ? clinic.id : 1;

  try {
    const id = saveWebRequest(
      { firstName, lastName, phone, email, dateOfBirth, preferredDate, preferredTime, reason, language },
      clinicId
    );
    sendWebRequestNotification(id,
      { firstName, lastName, phone, email, dateOfBirth, preferredDate, preferredTime, reason, language: language || 'en' },
      clinic
    ).catch(e => console.error('[Email] web request notify failed:', e.message));
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Could not save request. Please call us directly.' });
  }
});

module.exports = router;
