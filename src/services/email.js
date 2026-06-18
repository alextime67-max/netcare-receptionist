const nodemailer = require('nodemailer');

function createTransporter() {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }

  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  return null;
}

function baseHtmlLayout(title, body) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; }
  h2   { color: #1a5276; border-bottom: 2px solid #1a5276; padding-bottom: 8px; }
  table{ border-collapse: collapse; width: 100%; margin-top: 16px; }
  td   { padding: 10px 12px; border: 1px solid #ddd; vertical-align: top; }
  td:first-child { font-weight: bold; background: #f8f9fa; width: 35%; }
  .badge-urgent  { background:#c0392b; color:#fff; padding:3px 8px; border-radius:4px; font-size:12px; }
  .badge-routine { background:#27ae60; color:#fff; padding:3px 8px; border-radius:4px; font-size:12px; }
  .footer { margin-top:24px; font-size:11px; color:#888; border-top:1px solid #eee; padding-top:12px; }
</style></head>
<body>
<h2>${title}</h2>
${body}
<div class="footer">
  NetCare AI Receptionist &bull;
  <a href="${process.env.APP_URL || 'http://localhost:3000'}/admin">Open Admin Dashboard</a>
</div>
</body></html>`;
}

function row(label, value) {
  return `<tr><td>${label}</td><td>${value || '<em>Not provided</em>'}</td></tr>`;
}

async function sendAppointmentNotification(callId, data) {
  const transporter = createTransporter();
  if (!transporter) {
    console.log('[Email] No transporter configured — appointment notification logged only.');
    console.log('[Email] Appointment:', JSON.stringify({ callId, ...data }, null, 2));
    return;
  }

  const langLabel = data.language === 'es' ? 'Spanish / Español' : 'English';
  const html = baseHtmlLayout(
    '📅 New Appointment Request — NetCare',
    `<table>
      ${row('Patient Name',   data.name)}
      ${row('Phone Number',   data.phone)}
      ${row('Preferred Date', data.appointmentDate)}
      ${row('Preferred Time', data.appointmentTime)}
      ${row('Reason',         data.reason)}
      ${row('Language',       langLabel)}
      ${row('Call ID',        callId)}
      ${row('Received',       new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))}
    </table>`
  );

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'receptionist@netcare.com',
    to:      process.env.CLINIC_EMAIL,
    subject: `[NetCare] Appointment Request — ${data.name}`,
    html,
  });

  console.log(`[Email] Appointment notification sent for call ${callId}`);
}

async function sendDoctorMessageNotification(callId, data) {
  const transporter = createTransporter();
  if (!transporter) {
    console.log('[Email] No transporter configured — doctor message notification logged only.');
    console.log('[Email] Message:', JSON.stringify({ callId, ...data }, null, 2));
    return;
  }

  const urgencyBadge = data.urgency === 'urgent'
    ? '<span class="badge-urgent">URGENT</span>'
    : '<span class="badge-routine">Routine</span>';
  const langLabel = data.language === 'es' ? 'Spanish / Español' : 'English';
  const subjectPrefix = data.urgency === 'urgent' ? '[URGENT] ' : '';

  const html = baseHtmlLayout(
    `📋 Doctor Message ${urgencyBadge} — NetCare`,
    `<table>
      ${row('Patient Name',  data.name)}
      ${row('Phone Number',  data.phone)}
      ${row('Message',       data.messageContent)}
      ${row('Urgency',       urgencyBadge)}
      ${row('Language',      langLabel)}
      ${row('Call ID',       callId)}
      ${row('Received',      new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))}
    </table>`
  );

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'receptionist@netcare.com',
    to:      process.env.CLINIC_EMAIL,
    subject: `${subjectPrefix}[NetCare] Doctor Message — ${data.name}`,
    html,
  });

  console.log(`[Email] Doctor message notification sent for call ${callId} (${data.urgency})`);
}

module.exports = { sendAppointmentNotification, sendDoctorMessageNotification };
