const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');

const {
  initSession, getSession, setSessionDbId, endSession,
  setSelectedCenter, incrementIvrTimeouts,
  processMessage, getInitialGreeting, getNoInputMessage, getTimeoutGoodbye,
} = require('../services/ai');

const {
  createCall, updateCall, addTranscript,
  createAppointment, createDoctorMessage, getCallByCallSid,
  getClinicBySlug, getKnowledgeBase, logUnansweredQuestion,
} = require('../database/db');

const { sendAppointmentNotification, sendDoctorMessageNotification } = require('../services/email');
const {
  sendAppointmentConfirmationSms,
  sendMessageReceiptSms,
  sendMissedCallSms,
  sendVoicemailAckSms,
} = require('../services/sms');

// ── TwiML helpers ─────────────────────────────────────────────────────────────

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function gatherTwiml(speakText, lang, slug) {
  const voice    = lang === 'es' ? 'Polly.Lupe'  : 'Polly.Joanna';
  const langCode = lang === 'es' ? 'es-US'       : 'en-US';
  const hints    = lang === 'es'
    ? 'cita,doctor,mensaje,sí,no,urgente,nombre,apellido,teléfono,fecha,hora'
    : 'appointment,doctor,message,yes,no,urgent,name,phone,date,time,morning,afternoon';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/webhook/${slug}/gather" method="POST"
          speechTimeout="4" speechModel="phone_call"
          language="${langCode}" hints="${esc(hints)}">
    <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/${slug}/no-input</Redirect>
</Response>`;
}

function endTwiml(speakText, lang) {
  const voice    = lang === 'es' ? 'Polly.Lupe'  : 'Polly.Joanna';
  const langCode = lang === 'es' ? 'es-US'       : 'en-US';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  <Hangup/>
</Response>`;
}

function transferTwiml(speakText, lang, transferPhone, callerPhone) {
  const voice    = lang === 'es' ? 'Polly.Lupe'  : 'Polly.Joanna';
  const langCode = lang === 'es' ? 'es-US'       : 'en-US';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  <Dial timeout="30" callerId="${esc(callerPhone || '')}">${esc(transferPhone)}</Dial>
</Response>`;
}

function voicemailTwiml(speakText, lang, slug) {
  const voice    = lang === 'es' ? 'Polly.Lupe'  : 'Polly.Joanna';
  const langCode = lang === 'es' ? 'es-US'       : 'en-US';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  <Record action="/webhook/${slug}/recording-complete" method="POST"
          maxLength="120" finishOnKey="#" playBeep="true" timeout="5"/>
  <Say voice="${voice}" language="${langCode}">${esc(
    lang === 'es' ? 'No recibimos grabación. ¡Adiós!' : 'No recording received. Goodbye!'
  )}</Say>
  <Hangup/>
</Response>`;
}

function ivrMenuTwiml(clinic, slug) {
  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }
  if (!cfg) {
    const greeting = getInitialGreeting(clinic);
    return gatherTwiml(greeting, 'es', slug);
  }
  const voice    = cfg.voice    || 'Polly.Joanna';
  const langCode = cfg.language || 'en-US';
  const optText  = cfg.options.map(o => `For our ${o.label}, press ${o.digit}.`).join(' ');
  const repText  = cfg.repeatDigit ? `To hear these options again, press ${cfg.repeatDigit}.` : '';
  const fullText = [cfg.greeting, optText, repText].filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" action="/webhook/${slug}/ivr-select" method="POST"
          numDigits="1" timeout="10">
    <Say voice="${voice}" language="${langCode}">${esc(fullText)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/${slug}/ivr</Redirect>
</Response>`;
}

// ── Clinic middleware ─────────────────────────────────────────────────────────

function clinicMiddleware(req, res, next) {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic || clinic.status === 'suspended' || clinic.status === 'cancelled') {
    return res.status(404).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not currently in service. Please contact your clinic directly.</Say><Hangup/></Response>'
    );
  }
  req.clinic = clinic;

  // Optional per-clinic Twilio signature validation
  if (clinic.twilio_validate && clinic.twilio_token) {
    const appUrl    = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const signature = req.headers['x-twilio-signature'] || '';
    const url       = `${appUrl.replace(/\/$/, '')}${req.originalUrl}`;
    if (!twilio.validateRequest(clinic.twilio_token, signature, url, req.body)) {
      console.warn(`[Webhook/${clinic.slug}] Rejected invalid Twilio signature`);
      return res.status(403).type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized</Say></Response>'
      );
    }
  }

  next();
}

// ── Route: initial inbound call ───────────────────────────────────────────────

router.post('/:slug/voice', clinicMiddleware, (req, res) => {
  const { CallSid, From } = req.body;
  const clinic = req.clinic;
  console.log(`[Webhook/${clinic.slug}] Inbound call  CallSid=${CallSid}  From=${From}`);

  const kb = getKnowledgeBase(clinic.id);
  initSession(CallSid, From, clinic, kb);
  const dbId = createCall(CallSid, From, clinic.id);
  setSessionDbId(CallSid, dbId);

  if (clinic.ivr_enabled) {
    console.log(`[Webhook/${clinic.slug}] IVR menu  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug));
  }

  const greeting = getInitialGreeting(clinic);
  addTranscript(dbId, 'assistant', greeting);
  res.type('text/xml').send(gatherTwiml(greeting, 'es', clinic.slug));
});

// ── Route: IVR repeat / timeout ───────────────────────────────────────────────

router.post('/:slug/ivr', clinicMiddleware, (req, res) => {
  const { CallSid } = req.body;
  const clinic  = req.clinic;
  const timeouts = incrementIvrTimeouts(CallSid);
  const session  = getSession(CallSid);

  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }

  if (timeouts >= 2) {
    const voice    = cfg?.voice    || 'Polly.Joanna';
    const langCode = cfg?.language || 'en-US';
    const dispName = cfg?.clinicDisplayName || clinic.name;
    const greeting = `Thank you for calling ${dispName}. I am the virtual assistant. How may I assist you today?`;
    if (session?.dbId) addTranscript(session.dbId, 'assistant', greeting);
    console.log(`[Webhook/${clinic.slug}] IVR timeout×2 — falling back to AI  CallSid=${CallSid}`);
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/webhook/${clinic.slug}/gather" method="POST"
          speechTimeout="4" speechModel="phone_call" language="${langCode}">
    <Say voice="${voice}" language="${langCode}">${esc(greeting)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/${clinic.slug}/no-input</Redirect>
</Response>`);
  }

  console.log(`[Webhook/${clinic.slug}] IVR repeat (timeout ${timeouts})  CallSid=${CallSid}`);
  res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug));
});

// ── Route: IVR digit selection ────────────────────────────────────────────────

router.post('/:slug/ivr-select', clinicMiddleware, (req, res) => {
  const { CallSid, Digits } = req.body;
  const clinic  = req.clinic;
  const session = getSession(CallSid);

  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }

  if (!cfg || !Digits) {
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug));
  }

  const voice    = cfg.voice    || 'Polly.Joanna';
  const langCode = cfg.language || 'en-US';
  const dispName = cfg.clinicDisplayName || clinic.name;

  if (Digits === String(cfg.repeatDigit)) {
    console.log(`[Webhook/${clinic.slug}] IVR repeat requested  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug));
  }

  const option = cfg.options.find(o => String(o.digit) === String(Digits));
  if (!option) {
    console.log(`[Webhook/${clinic.slug}] IVR invalid digit=${Digits}  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug));
  }

  setSelectedCenter(CallSid, option);
  const greeting = `Thank you. You have selected our ${option.label} location. I am ${dispName}'s virtual assistant. How may I assist you today?`;
  if (session?.dbId) addTranscript(session.dbId, 'assistant', greeting);
  console.log(`[Webhook/${clinic.slug}] IVR selected: ${option.label}  CallSid=${CallSid}`);

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/webhook/${clinic.slug}/gather" method="POST"
          speechTimeout="4" speechModel="phone_call" language="${langCode}">
    <Say voice="${voice}" language="${langCode}">${esc(greeting)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/${clinic.slug}/no-input</Redirect>
</Response>`);
});

// ── Route: speech gathered ────────────────────────────────────────────────────

router.post('/:slug/gather', clinicMiddleware, async (req, res) => {
  const { CallSid, SpeechResult = '', Confidence } = req.body;
  const clinic = req.clinic;
  console.log(`[Webhook/${clinic.slug}] Gather  CallSid=${CallSid}  speech="${SpeechResult}"  conf=${Confidence}`);

  const session = getSession(CallSid);
  if (!session) {
    return res.type('text/xml').send(
      endTwiml(`Perdimos su sesión. Por favor llame nuevamente. Gracias por llamar a ${clinic.name}.`, 'es')
    );
  }

  if (session.dbId && SpeechResult) {
    addTranscript(session.dbId, 'patient', SpeechResult);
  }

  try {
    const ai = await processMessage(CallSid, SpeechResult || '[silence]');

    if (session.dbId) {
      addTranscript(session.dbId, 'assistant', ai.speak);
      updateCall(CallSid, {
        patient_name:       ai.collected.name,
        patient_phone:      ai.collected.phone,
        call_type:          ai.collected.callType || 'unknown',
        language:           ai.language,
        emergency_detected: ai.emergencyDetected ? 1 : 0,
      });
      if (ai.unanswered && SpeechResult) {
        try { logUnansweredQuestion(clinic.id, session.dbId, SpeechResult); }
        catch (e) { console.error('[KB] logUnansweredQuestion error:', e.message); }
      }
    }

    // Live call transfer — emit <Dial> TwiML when AI flags transfer
    if (ai.transfer && clinic.transfer_phone) {
      if (session.dbId) {
        addTranscript(session.dbId, 'assistant', ai.speak);
        updateCall(CallSid, {
          patient_name:  ai.collected.name,
          patient_phone: ai.collected.phone,
          call_type:     'transfer',
          language:      ai.language,
          status:        'transferred',
        });
      }
      endSession(CallSid);
      console.log(`[Webhook/${clinic.slug}] Transferring call ${CallSid} → ${clinic.transfer_phone}`);
      return res.type('text/xml').send(
        transferTwiml(ai.speak, ai.language, clinic.transfer_phone, clinic.twilio_phone)
      );
    }

    if (ai.complete) {
      await finalizeCall(CallSid, ai, clinic);
      return res.type('text/xml').send(endTwiml(ai.speak, ai.language));
    }

    res.type('text/xml').send(gatherTwiml(ai.speak, ai.language, clinic.slug));
  } catch (err) {
    console.error(`[Webhook/${clinic.slug}] gather error:`, err);
    const lang = session.language || 'es';
    res.type('text/xml').send(gatherTwiml(
      lang === 'es'
        ? 'Lo siento, tuve un problema técnico. ¿Podría repetir eso?'
        : "I'm sorry, I had a technical issue. Could you please repeat that?",
      lang, clinic.slug
    ));
  }
});

// ── Route: no input ───────────────────────────────────────────────────────────

router.post('/:slug/no-input', clinicMiddleware, (req, res) => {
  const { CallSid } = req.body;
  const clinic  = req.clinic;
  const session = getSession(CallSid);
  const lang    = session?.language || 'es';

  if (session) {
    session.silenceCount = (session.silenceCount || 0) + 1;

    if (session.silenceCount >= 3) {
      if (session.dbId) {
        updateCall(CallSid, { status: 'abandoned' });
        addTranscript(session.dbId, 'assistant', getTimeoutGoodbye(lang, clinic.name));
        // Send missed-call SMS if caller is known
        if (session.callerNumber && session.callerNumber !== 'anonymous') {
          sendMissedCallSms(clinic, session.callerNumber)
            .catch(e => console.error('[SMS] missed-call SMS failed:', e.message));
        }
      }
      endSession(CallSid);
      return res.type('text/xml').send(endTwiml(getTimeoutGoodbye(lang, clinic.name), lang));
    }

    // On 2nd silence, offer voicemail
    if (session.silenceCount === 2) {
      const prompt = lang === 'es'
        ? 'No hemos recibido respuesta. Después del tono puede dejar un mensaje detallando su problema. Presione # cuando termine.'
        : "We didn't receive a response. After the beep, please leave a message describing your issue. Press # when done.";
      if (session.dbId) addTranscript(session.dbId, 'assistant', prompt);
      return res.type('text/xml').send(voicemailTwiml(prompt, lang, clinic.slug));
    }
  }

  res.type('text/xml').send(gatherTwiml(getNoInputMessage(lang), lang, clinic.slug));
});

// ── Route: Twilio status callback ─────────────────────────────────────────────

router.post('/:slug/status', clinicMiddleware, (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const clinic = req.clinic;
  console.log(`[Webhook/${clinic.slug}] Status  CallSid=${CallSid}  status=${CallStatus}  duration=${CallDuration}s`);

  try {
    const call = getCallByCallSid(CallSid);
    if (call) {
      const terminal = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];
      if (terminal.includes(CallStatus)) {
        updateCall(CallSid, {
          duration: CallDuration ? parseInt(CallDuration, 10) : null,
          status:   call.status === 'in_progress' ? 'abandoned' : call.status,
        });
        endSession(CallSid);
      }
    }
  } catch (err) {
    console.error(`[Webhook/${clinic.slug}] status callback error:`, err.message);
  }

  res.status(204).send();
});

// ── Route: voicemail entry point (explicit redirect) ──────────────────────────

router.post('/:slug/voicemail', clinicMiddleware, (req, res) => {
  const { CallSid } = req.body;
  const clinic  = req.clinic;
  const session = getSession(CallSid);
  const lang    = session?.language || 'es';

  const prompt = lang === 'es'
    ? 'Por favor deje su mensaje después del tono. Presione # cuando termine.'
    : 'Please leave your message after the beep. Press # when finished.';

  if (session?.dbId) addTranscript(session.dbId, 'assistant', prompt);

  console.log(`[Webhook/${clinic.slug}] Voicemail started  CallSid=${CallSid}`);
  res.type('text/xml').send(voicemailTwiml(prompt, lang, clinic.slug));
});

// ── Route: recording complete callback ────────────────────────────────────────

router.post('/:slug/recording-complete', clinicMiddleware, async (req, res) => {
  const { CallSid, RecordingUrl, RecordingDuration } = req.body;
  const clinic  = req.clinic;
  const session = getSession(CallSid);
  const lang    = session?.language || 'es';
  const duration = parseInt(RecordingDuration || '0', 10);

  console.log(`[Webhook/${clinic.slug}] Recording complete  CallSid=${CallSid}  dur=${duration}s  url=${RecordingUrl}`);

  if (RecordingUrl && duration > 0) {
    updateCall(CallSid, { recording_url: RecordingUrl, voicemail_left: 1, status: 'voicemail' });
    if (session?.dbId) addTranscript(session.dbId, 'assistant', `[Voicemail recorded — ${duration}s]`);

    // Acknowledge via SMS
    const callerPhone = session?.callerNumber || req.body.From;
    if (callerPhone && callerPhone !== 'anonymous') {
      sendVoicemailAckSms(clinic, callerPhone)
        .catch(e => console.error('[SMS] voicemail ack SMS failed:', e.message));
    }
  }

  endSession(CallSid);

  const goodbye = lang === 'es'
    ? '¡Su mensaje ha sido grabado! Le llamaremos pronto. ¡Adiós!'
    : 'Your message has been recorded. We will call you back soon. Goodbye!';

  res.type('text/xml').send(endTwiml(goodbye, lang));
});

// ── Internal: finalize completed call ─────────────────────────────────────────

async function finalizeCall(callSid, ai, clinic) {
  const session = getSession(callSid);
  if (!session?.dbId) return;

  const { collected } = ai;
  const callId   = session.dbId;
  const clinicId = clinic.id;

  updateCall(callSid, {
    patient_name:       collected.name,
    patient_phone:      collected.phone,
    call_type:          collected.callType || 'unknown',
    language:           ai.language,
    status:             ai.emergencyDetected ? 'emergency' : 'completed',
    emergency_detected: ai.emergencyDetected ? 1 : 0,
  });

  if (!ai.emergencyDetected) {
    try {
      if (collected.callType === 'appointment') {
        createAppointment(callId, {
          name:            collected.name,
          phone:           collected.phone,
          appointmentDate: collected.appointmentDate,
          appointmentTime: collected.appointmentTime,
          reason:          collected.reason,
        }, clinicId);
        sendAppointmentNotification(callId, { ...collected, language: ai.language }, clinic)
          .catch(e => console.error('[Email] appointment notify failed:', e.message));
        sendAppointmentConfirmationSms(clinic, collected.phone, collected.name, collected.appointmentDate, collected.appointmentTime)
          .catch(e => console.error('[SMS] appointment SMS failed:', e.message));

      } else if (collected.callType === 'message') {
        createDoctorMessage(callId, {
          name:           collected.name,
          phone:          collected.phone,
          messageContent: collected.messageContent,
          urgency:        collected.urgency,
        }, clinicId);
        sendDoctorMessageNotification(callId, { ...collected, language: ai.language }, clinic)
          .catch(e => console.error('[Email] doctor msg notify failed:', e.message));
        sendMessageReceiptSms(clinic, collected.phone, collected.name)
          .catch(e => console.error('[SMS] message receipt SMS failed:', e.message));
      }
    } catch (err) {
      console.error(`[Webhook/${clinic.slug}] finalizeCall DB error:`, err.message);
    }
  }

  endSession(callSid);
  console.log(`[Webhook/${clinic.slug}] Call ${callSid} finalized — type=${collected.callType} lang=${ai.language}`);
}

module.exports = router;
