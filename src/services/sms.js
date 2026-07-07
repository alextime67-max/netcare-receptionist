'use strict';

const TELNYX_API = 'https://api.telnyx.com/v2';

async function telnyxSend(from, to, text, apiKey) {
  const key = apiKey || process.env.TELNYX_API_KEY;
  if (!key) throw new Error('TELNYX_API_KEY not configured');
  const r = await fetch(`${TELNYX_API}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({ from, to, text }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Telnyx SMS ${r.status}: ${body}`);
  }
  const data = await r.json();
  return data.data?.id || null;
}

async function sendSmsFollowUp(clinic, toPhone, message) {
  if (!clinic?.sms_follow_up_enabled) return null;
  if (!clinic.telnyx_phone) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;

  try {
    const id = await telnyxSend(
      clinic.telnyx_phone,
      toPhone,
      message,
      clinic.telnyx_api_key || undefined,
    );
    console.log(`[SMS] Sent to ${toPhone} — id=${id}`);
    return id;
  } catch (err) {
    console.error(`[SMS] Failed to ${toPhone}: ${err.message}`);
    return null;
  }
}

async function sendAppointmentConfirmationSms(clinic, toPhone, patientName, location, date, time, language) {
  // Appointment confirmations bypass sms_follow_up_enabled — always send when Telnyx is configured
  if (!clinic?.telnyx_phone) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;

  const name = patientName || 'there';
  const loc  = location || '';
  let message;

  if (language === 'es') {
    const locPart  = loc  ? ` para ${loc}`     : '';
    const datePart = date ? ` para el ${date}` : '';
    const timePart = time ? ` a las ${time}`   : '';
    message = `MDcare Medical Centers: Hola ${name}, su solicitud de cita${locPart} fue recibida${datePart}${timePart}. Nuestro equipo le confirmará la cita. Gracias.`;
  } else {
    const locPart  = loc  ? ` for ${loc}`  : '';
    const datePart = date ? ` for ${date}` : '';
    const timePart = time ? ` at ${time}`  : '';
    message = `MDcare Medical Centers: Hi ${name}, your appointment request${locPart} was received${datePart}${timePart}. Our team will confirm your appointment. Thank you.`;
  }

  try {
    const id = await telnyxSend(
      clinic.telnyx_phone,
      toPhone,
      message,
      clinic.telnyx_api_key || undefined,
    );
    console.log(`[SMS] Appointment confirmation sent to ${toPhone} — id=${id}`);
    return id;
  } catch (err) {
    console.error(`[SMS] Appointment confirmation failed to ${toPhone}: ${err.message}`);
    return null;
  }
}

async function sendMessageReceiptSms(clinic, toPhone, patientName) {
  const name    = patientName || 'there';
  const message = `Hi ${name}, your message to ${clinic.name} has been forwarded to your care team. We will be in touch soon. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

async function sendMissedCallSms(clinic, toPhone) {
  const callBackAt = clinic.phone_display || clinic.telnyx_phone || 'our office';
  const message    = `You recently missed a call from ${clinic.name}. Please call us back at ${callBackAt} when you get a chance. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

async function sendVoicemailAckSms(clinic, toPhone) {
  const message = `Hi! We received your voicemail at ${clinic.name} and will call you back soon. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

module.exports = {
  sendSmsFollowUp,
  sendAppointmentConfirmationSms,
  sendMessageReceiptSms,
  sendMissedCallSms,
  sendVoicemailAckSms,
};
