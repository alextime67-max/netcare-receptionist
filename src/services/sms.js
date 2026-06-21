const twilio = require('twilio');

function getTwilioClient(clinic) {
  if (!clinic?.twilio_sid || !clinic?.twilio_token) return null;
  return twilio(clinic.twilio_sid, clinic.twilio_token);
}

async function sendSmsFollowUp(clinic, toPhone, message) {
  if (!clinic?.sms_follow_up_enabled) return null;
  if (!clinic.twilio_phone || !clinic.twilio_sid || !clinic.twilio_token) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;

  const client = getTwilioClient(clinic);
  if (!client) return null;

  try {
    const msg = await client.messages.create({
      body: message,
      from: clinic.twilio_phone,
      to:   toPhone,
    });
    console.log(`[SMS] Sent to ${toPhone} — SID=${msg.sid}`);
    return msg.sid;
  } catch (err) {
    console.error(`[SMS] Failed to ${toPhone}: ${err.message}`);
    return null;
  }
}

async function sendAppointmentConfirmationSms(clinic, toPhone, patientName, location, date, time, language) {
  // Appointment confirmations bypass the sms_follow_up_enabled toggle — they are
  // always sent when Twilio is configured, because the patient expects this message.
  if (!clinic?.twilio_phone || !clinic?.twilio_sid || !clinic?.twilio_token) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;

  const name = patientName || 'there';
  const loc  = location || '';
  let message;

  if (language === 'es') {
    const locPart  = loc  ? ` para ${loc}`              : '';
    const datePart = date ? ` para el ${date}`           : '';
    const timePart = time ? ` a las ${time}`             : '';
    message = `MDcare Medical Centers: Hola ${name}, su solicitud de cita${locPart} fue recibida${datePart}${timePart}. Nuestro equipo le confirmará la cita. Gracias.`;
  } else {
    const locPart  = loc  ? ` for ${loc}`               : '';
    const datePart = date ? ` for ${date}`               : '';
    const timePart = time ? ` at ${time}`                : '';
    message = `MDcare Medical Centers: Hi ${name}, your appointment request${locPart} was received${datePart}${timePart}. Our team will confirm your appointment. Thank you.`;
  }

  // Let Twilio errors propagate so the caller can record a failed status.
  const client = getTwilioClient(clinic);
  const msg = await client.messages.create({ body: message, from: clinic.twilio_phone, to: toPhone });
  console.log(`[SMS] Appointment confirmation sent to ${toPhone} — SID=${msg.sid}`);
  return msg.sid;
}

async function sendMessageReceiptSms(clinic, toPhone, patientName) {
  const name    = patientName || 'there';
  const message =
    `Hi ${name}, your message to ${clinic.name} has been forwarded to your care team. ` +
    `We will be in touch soon. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message);
}

async function sendMissedCallSms(clinic, toPhone) {
  const callBackAt = clinic.phone_display || clinic.twilio_phone || 'our office';
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
