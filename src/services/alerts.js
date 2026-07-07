'use strict';

const nodemailer = require('nodemailer');
const { getCostConfig, getClinics, logCostAlert, getLastAlertByType } = require('../database/db');
const { getDashboardStats } = require('./costs');

const TELNYX_API  = 'https://api.telnyx.com/v2';
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours between repeat alerts

function cooldownPassed(lastAlert) {
  if (!lastAlert) return true;
  return Date.now() - new Date(lastAlert.created_at).getTime() > COOLDOWN_MS;
}

async function sendAlertSms(config, message, clinics) {
  if (!config.admin_phone) return false;
  const sender = clinics.find(c => c.telnyx_phone);
  if (!sender) return false;
  const apiKey = sender.telnyx_api_key || process.env.TELNYX_API_KEY;
  if (!apiKey) return false;
  try {
    const r = await fetch(`${TELNYX_API}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: sender.telnyx_phone,
        to:   config.admin_phone,
        text: `[NetCare Alert] ${message}`,
      }),
    });
    if (!r.ok) throw new Error(`${r.status}`);
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

  return results;
}

async function getActiveAlerts() {
  const config = getCostConfig();
  const stats  = getDashboardStats();
  const alerts = [];

  const aiRemaining = stats.aiRemaining;
  if (aiRemaining <= (config.threshold_ai_critical || 2)) {
    alerts.push({ type: 'ai_critical', severity: 'critical',
      message: `AI budget critically low — $${aiRemaining.toFixed(2)} remaining of $${(config.ai_monthly_budget || 200).toFixed(2)} budget.` });
  } else if (aiRemaining <= (config.threshold_ai_low || 5)) {
    alerts.push({ type: 'ai_low', severity: 'warning',
      message: `AI budget low — $${aiRemaining.toFixed(2)} remaining of $${(config.ai_monthly_budget || 200).toFixed(2)} budget.` });
  }

  return alerts;
}

module.exports = { checkAndSendAlerts, getActiveAlerts };
