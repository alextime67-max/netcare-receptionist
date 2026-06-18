const express = require('express');
const router  = express.Router();
const { saveWebRequest } = require('../database/db');

router.post('/request', (req, res) => {
  const { firstName, lastName, phone, email, dateOfBirth, preferredDate, preferredTime, reason, language } = req.body;

  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ error: 'First name, last name, and phone are required.' });
  }

  try {
    const id = saveWebRequest({ firstName, lastName, phone, email, dateOfBirth, preferredDate, preferredTime, reason, language });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Could not save request. Please call us directly.' });
  }
});

module.exports = router;
