const nodemailer = require('nodemailer');

function createTransporter(clinic) {
  // clinic can be a DB clinic row or null (falls back to env vars)
  const gmailUser = clinic?.gmail_user       || process.env.GMAIL_USER;
  const gmailPass = clinic?.gmail_app_pass   || process.env.GMAIL_APP_PASSWORD;
  const smtpHost  = clinic?.smtp_host        || process.env.SMTP_HOST;

  if (gmailUser && gmailPass) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
  }

  if (smtpHost) {
    return nodemailer.createTransport({
      host:   smtpHost,
      port:   parseInt(clinic?.smtp_port || process.env.SMTP_PORT || '587'),
      secure: !!(clinic?.smtp_secure || process.env.SMTP_SECURE === 'true'),
      auth: {
        user: clinic?.smtp_user || process.env.SMTP_USER,
        pass: clinic?.smtp_pass || process.env.SMTP_PASS,
      },
    });
  }

  return null;
}

function baseHtmlLayout(title, body, clinic) {
  const adminUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const slug     = clinic?.slug || 'netcare';
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
  ${clinic?.name || 'NetCare'} AI Receptionist &bull;
  <a href="${adminUrl}/admin/${slug}">Open Admin Dashboard</a>
</div>
</body></html>`;
}

function row(label, value) {
  return `<tr><td>${label}</td><td>${value || '<em>Not provided</em>'}</td></tr>`;
}

async function sendAppointmentNotification(callId, data, clinic) {
  const transporter = createTransporter(clinic);
  const toEmail     = clinic?.clinic_email || process.env.CLINIC_EMAIL;
  const fromEmail   = clinic?.email_from   || process.env.EMAIL_FROM || 'receptionist@netcare.com';

  if (!transporter) {
    console.log('[Email] No transporter configured — appointment notification logged only.');
    console.log('[Email] Appointment:', JSON.stringify({ callId, ...data }, null, 2));
    return;
  }

  const langLabel = data.language === 'es' ? 'Spanish / Español' : 'English';
  const html = baseHtmlLayout(
    `📅 New Appointment Request — ${clinic?.name || 'NetCare'}`,
    `<table>
      ${row('Patient Name',   data.name)}
      ${row('Phone Number',   data.phone)}
      ${row('Preferred Date', data.appointmentDate)}
      ${row('Preferred Time', data.appointmentTime)}
      ${row('Reason',         data.reason)}
      ${row('Language',       langLabel)}
      ${row('Call ID',        callId)}
      ${row('Received',       new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))}
    </table>`,
    clinic
  );

  await transporter.sendMail({
    from:    fromEmail,
    to:      toEmail,
    subject: `[${clinic?.name || 'NetCare'}] Appointment Request — ${data.name}`,
    html,
  });

  console.log(`[Email] Appointment notification sent for call ${callId}`);
}

async function sendDoctorMessageNotification(callId, data, clinic) {
  const transporter = createTransporter(clinic);
  const toEmail     = clinic?.clinic_email || process.env.CLINIC_EMAIL;
  const fromEmail   = clinic?.email_from   || process.env.EMAIL_FROM || 'receptionist@netcare.com';

  if (!transporter) {
    console.log('[Email] No transporter configured — doctor message notification logged only.');
    console.log('[Email] Message:', JSON.stringify({ callId, ...data }, null, 2));
    return;
  }

  const urgencyBadge = data.urgency === 'urgent'
    ? '<span class="badge-urgent">URGENT</span>'
    : '<span class="badge-routine">Routine</span>';
  const langLabel      = data.language === 'es' ? 'Spanish / Español' : 'English';
  const subjectPrefix  = data.urgency === 'urgent' ? '[URGENT] ' : '';

  const html = baseHtmlLayout(
    `📋 Doctor Message ${urgencyBadge} — ${clinic?.name || 'NetCare'}`,
    `<table>
      ${row('Patient Name',  data.name)}
      ${row('Phone Number',  data.phone)}
      ${row('Message',       data.messageContent)}
      ${row('Urgency',       urgencyBadge)}
      ${row('Language',      langLabel)}
      ${row('Call ID',       callId)}
      ${row('Received',      new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))}
    </table>`,
    clinic
  );

  await transporter.sendMail({
    from:    fromEmail,
    to:      toEmail,
    subject: `${subjectPrefix}[${clinic?.name || 'NetCare'}] Doctor Message — ${data.name}`,
    html,
  });

  console.log(`[Email] Doctor message notification sent for call ${callId} (${data.urgency})`);
}

async function sendWebRequestNotification(requestId, data, clinic) {
  const transporter = createTransporter(clinic);
  const toEmail     = clinic?.clinic_email || process.env.CLINIC_EMAIL;
  const fromEmail   = clinic?.email_from   || process.env.EMAIL_FROM || 'receptionist@netcare.com';

  if (!transporter) {
    console.log('[Email] No transporter configured — web request notification logged only.');
    console.log('[Email] Web request:', JSON.stringify({ requestId, ...data }, null, 2));
    return;
  }

  const langLabel = data.language === 'es' ? 'Spanish / Español' : 'English';
  const html = baseHtmlLayout(
    `🌐 New Web Appointment Request — ${clinic?.name || 'NetCare'}`,
    `<table>
      ${row('First Name',      data.firstName)}
      ${row('Last Name',       data.lastName)}
      ${row('Phone',           data.phone)}
      ${row('Email',           data.email)}
      ${row('Date of Birth',   data.dateOfBirth)}
      ${row('Preferred Date',  data.preferredDate)}
      ${row('Preferred Time',  data.preferredTime)}
      ${row('Reason',          data.reason)}
      ${row('Language',        langLabel)}
      ${row('Request ID',      requestId)}
      ${row('Received',        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))}
    </table>`,
    clinic
  );

  await transporter.sendMail({
    from:    fromEmail,
    to:      toEmail,
    subject: `[${clinic?.name || 'NetCare'}] Web Request — ${data.firstName} ${data.lastName}`,
    html,
  });

  console.log(`[Email] Web request notification sent for request ${requestId}`);
}

module.exports = { sendAppointmentNotification, sendDoctorMessageNotification, sendWebRequestNotification };
