const twilio     = require('twilio');
const nodemailer = require('nodemailer');
const { getCostConfig, getClinics, logCostAlert, getLastAlertByType } = require('../database/db');
const { getDashboardStats } = require('./costs');

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between repeat alerts

function cooldownPassed(lastAlert) {
  if (!lastAlert) return true;
  return Date.now() - new Date(lastAlert.created_at).getTime() > COOLDOWN_MS;
}

async function getTwilioBalance(clinic) {
  if (!clinic.twilio_sid || !clinic.twilio_token) return null;
  try {
    const client  = twilio(clinic.twilio_sid, clinic.twilio_token);
    const balance = await client.api.accounts(clinic.twilio_sid).balance.fetch();
    return parseFloat(balance.balance);
  } catch {
    return null;
  }
}

async function sendAlertSms(config, message, clinics) {
  if (!config.admin_phone) return false;
  const sender = clinics.find(c => c.twilio_sid && c.twilio_token && c.twilio_phone);
  if (!sender) return false;
  try {
    const client = twilio(sender.twilio_sid, sender.twilio_token);
    await client.messages.create({
      to:   config.admin_phone,
      from: sender.twilio_phone,
      body: `[NetCare Alert] ${message}`,
    });
    return true;
  } catch (e) {
    console.error('[Alert] SMS send failed:', e.message);
    return false;
  }
}

async function sendAlertEmail(config, message) {
  if (!config.admin_email) return false;
  try {
    let transporter;
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      });
    } else if (process.env.SMTP_HOST) {
      transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    } else {
      return false;
    }
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM || 'alerts@netcare-phone.com',
      to:      config.admin_email,
      subject: '[NetCare Phone] Cost Alert',
      text:    message,
    });
    return true;
  } catch (e) {
    console.error('[Alert] Email send failed:', e.message);
    return false;
  }
}

async function checkAndSendAlerts() {
  const config  = getCostConfig();
  if (!config.alerts_enabled) return [];

  const clinics = getClinics();
  const stats   = getDashboardStats();
  const results = [];

  // ── AI budget alerts ────────────────────────────────────────────────────────

  const aiRemaining = stats.aiRemaining;

  if (aiRemaining <= (config.threshold_ai_critical || 2)) {
    const type = 'ai_critical';
    const msg  = `CRITICAL: AI budget nearly depleted. $${aiRemaining.toFixed(2)} remaining of $${(config.ai_monthly_budget || 200).toFixed(2)} monthly budget.`;
    if (cooldownPassed(getLastAlertByType(type))) {
      logCostAlert(type, msg, aiRemaining, config.threshold_ai_critical);
      const sms   = await sendAlertSms(config, msg, clinics);
      const email = await sendAlertEmail(config, msg);
      results.push({ type, severity: 'critical', message: msg, value: aiRemaining, sms, email });
      console.log('[Alert] ai_critical fired');
    }
  } else if (aiRemaining <= (config.threshold_ai_low || 5)) {
    const type = 'ai_low';
    const msg  = `Warning: AI budget running low. $${aiRemaining.toFixed(2)} remaining of $${(config.ai_monthly_budget || 200).toFixed(2)} monthly budget.`;
    if (cooldownPassed(getLastAlertByType(type))) {
      logCostAlert(type, msg, aiRemaining, config.threshold_ai_low);
      const sms   = await sendAlertSms(config, msg, clinics);
      const email = await sendAlertEmail(config, msg);
      results.push({ type, severity: 'warning', message: msg, value: aiRemaining, sms, email });
      console.log('[Alert] ai_low fired');
    }
  }

  // ── Twilio balance alerts (per clinic) ──────────────────────────────────────

  for (const clinic of clinics) {
    if (!clinic.twilio_sid || !clinic.twilio_token) continue;
    const balance = await getTwilioBalance(clinic);
    if (balance === null) continue;
    if (balance <= (config.threshold_twilio_low || 10)) {
      const type = `twilio_low_${clinic.id}`;
      const msg  = `Twilio balance low for ${clinic.name}: $${balance.toFixed(2)} remaining (threshold: $${(config.threshold_twilio_low || 10).toFixed(2)}).`;
      if (cooldownPassed(getLastAlertByType(type))) {
        logCostAlert(type, msg, balance, config.threshold_twilio_low);
        const sms   = await sendAlertSms(config, msg, clinics);
        const email = await sendAlertEmail(config, msg);
        results.push({ type, severity: 'warning', message: msg, value: balance, sms, email, clinicName: clinic.name });
        console.log(`[Alert] twilio_low fired for ${clinic.name}`);
      }
    }
  }

  return results;
}

// Returns current alert state for dashboard display (no notifications sent)
async function getActiveAlerts() {
  const config  = getCostConfig();
  const clinics = getClinics();
  const stats   = getDashboardStats();
  const alerts  = [];

  const aiRemaining = stats.aiRemaining;
  if (aiRemaining <= (config.threshold_ai_critical || 2)) {
    alerts.push({ type: 'ai_critical', severity: 'critical',
      message: `AI budget critically low — $${aiRemaining.toFixed(2)} remaining of $${(config.ai_monthly_budget || 200).toFixed(2)} budget.` });
  } else if (aiRemaining <= (config.threshold_ai_low || 5)) {
    alerts.push({ type: 'ai_low', severity: 'warning',
      message: `AI budget low — $${aiRemaining.toFixed(2)} remaining of $${(config.ai_monthly_budget || 200).toFixed(2)} budget.` });
  }

  for (const clinic of clinics) {
    if (!clinic.twilio_sid || !clinic.twilio_token) continue;
    const balance = await getTwilioBalance(clinic);
    if (balance !== null && balance <= (config.threshold_twilio_low || 10)) {
      alerts.push({ type: `twilio_low_${clinic.id}`, severity: 'warning', clinicName: clinic.name,
        message: `Twilio balance low for ${clinic.name}: $${balance.toFixed(2)}` });
    }
  }

  return alerts;
}

module.exports = { checkAndSendAlerts, getActiveAlerts, getTwilioBalance };
