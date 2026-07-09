const TELNYX_MESSAGES_URL = 'https://api.telnyx.com/v2/messages';

function _getTelnyxKey(clinic) {
  return clinic?.telnyx_api_key || process.env.TELNYX_API_KEY || null;
}

async function _sendSms(apiKey, from, to, body) {
  const res = await fetch(TELNYX_MESSAGES_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, text: body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.detail || `Telnyx ${res.status}`);
  return data.data?.id;
}

async function sendSmsFollowUp(clinic, toPhone, message) {
  if (!clinic?.sms_follow_up_enabled) return null;
  const apiKey = _getTelnyxKey(clinic);
  if (!apiKey || !clinic.telnyx_phone) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;
  try {
    const id = await _sendSms(apiKey, clinic.telnyx_phone, toPhone, message);
    console.log(`[SMS] Sent to ${toPhone} — ID=${id}`);
    return id;
  } catch (err) {
    console.error(`[SMS] Failed to ${toPhone}: ${err.message}`);
    return null;
  }
}

async function sendAppointmentConfirmationSms(clinic, toPhone, patientName, location, date, time, language) {
  const apiKey = _getTelnyxKey(clinic);
  if (!apiKey || !clinic.telnyx_phone) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;

  const name = patientName || 'there';
  const loc  = location || '';
  let message;

  if (language === 'es') {
    const locPart  = loc  ? ` para ${loc}`    : '';
    const datePart = date ? ` para el ${date}` : '';
    const timePart = time ? ` a las ${time}`   : '';
    message = `MDcare Medical Centers: Hola ${name}, su solicitud de cita${locPart} fue recibida${datePart}${timePart}. Nuestro equipo le confirmará la cita. Gracias.`;
  } else {
    const locPart  = loc  ? ` for ${loc}`  : '';
    const datePart = date ? ` for ${date}` : '';
    const timePart = time ? ` at ${time}`  : '';
    message = `MDcare Medical Centers: Hi ${name}, your appointment request${locPart} was received${datePart}${timePart}. Our team will confirm your appointment. Thank you.`;
  }

  const id = await _sendSms(apiKey, clinic.telnyx_phone, toPhone, message);
  console.log(`[SMS] Appointment confirmation sent to ${toPhone} — ID=${id}`);
  return id;
}

async function sendMessageReceiptSms(clinic, toPhone, patientName) {
  const name    = patientName || 'there';
  const message =
    `Hi ${name}, your message to ${clinic.name} has been forwarded to your care team. ` +
    `We will be in touch soon. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

async function sendMissedCallSms(clinic, toPhone) {
  const callBackAt = clinic.phone_display || clinic.telnyx_phone || 'our office';
  const message =
    `You recently missed a call from ${clinic.name}. ` +
    `Please call us back at ${callBackAt} when you get a chance. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

async function sendVoicemailAckSms(clinic, toPhone) {
  const message =
    `Hi! We received your voicemail at ${clinic.name} and will call you back soon. ` +
    `Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

module.exports = {
  sendSmsFollowUp,
  sendAppointmentConfirmationSms,
  sendMessageReceiptSms,
  sendMissedCallSms,
  sendVoicemailAckSms,
};
