const express   = require('express');
const router    = express.Router();
const basicAuth = require('express-basic-auth');
const path      = require('path');

router.use(basicAuth({
  users:     { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'NetCare2024!' },
  challenge: true,
  realm:     'NetCare Admin Dashboard',
}));

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

module.exports = router;
