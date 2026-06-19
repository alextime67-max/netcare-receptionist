const express   = require('express');
const router    = express.Router();
const basicAuth = require('express-basic-auth');
const path      = require('path');
const fs        = require('fs');
const { getClinicBySlug } = require('../database/db');

// /admin/:slug  — per-clinic dashboard
router.get('/:slug', (req, res, next) => {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic) return res.status(404).send('Clinic not found.');

  basicAuth({
    users:     { [clinic.admin_user]: clinic.admin_pass },
    challenge: true,
    realm:     `${clinic.name} Admin`,
  })(req, res, () => {
    // Inject clinic slug + name into the HTML so the dashboard JS can use it
    let html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
    html = html
      .replace('<meta charset="UTF-8">', `<meta charset="UTF-8">
  <meta name="clinic-slug" content="${clinic.slug}">
  <meta name="clinic-name" content="${clinic.name.replace(/"/g, '&quot;')}">`)
      .replace('<title id="page-title">Admin Dashboard</title>',
               `<title>${clinic.name} — Admin Dashboard</title>`);
    res.type('html').send(html);
  });
});

module.exports = router;
