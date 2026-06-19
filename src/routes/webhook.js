const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');

const {
  initSession, getSession, setSessionDbId, endSession,
  processMessage, getInitialGreeting, getNoInputMessage, getTimeoutGoodbye,
} = require('../services/ai');

const {
  createCall, updateCall, addTranscript,
  createAppointment, createDoctorMessage, getCallByCallSid,
  getClinicBySlug,
} = require('../database/db');

const { sendAppointmentNotification, sendDoctorMessageNotification } = require('../services/email');

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

  initSession(CallSid, From, clinic);
  const dbId = createCall(CallSid, From, clinic.id);
  setSessionDbId(CallSid, dbId);

  const greeting = getInitialGreeting(clinic);
  addTranscript(dbId, 'assistant', greeting);

  res.type('text/xml').send(gatherTwiml(greeting, 'en', clinic.slug));
});

// ── Route: speech gathered ────────────────────────────────────────────────────

router.post('/:slug/gather', clinicMiddleware, async (req, res) => {
  const { CallSid, SpeechResult = '', Confidence } = req.body;
  const clinic = req.clinic;
  console.log(`[Webhook/${clinic.slug}] Gather  CallSid=${CallSid}  speech="${SpeechResult}"  conf=${Confidence}`);

  const session = getSession(CallSid);
  if (!session) {
    return res.type('text/xml').send(
      endTwiml(`We lost your session. Please call back. Thank you for calling ${clinic.name}.`, 'en')
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
    const lang = session.language || 'en';
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
  const lang    = session?.language || 'en';

  if (session) {
    session.silenceCount = (session.silenceCount || 0) + 1;
    if (session.silenceCount >= 3) {
      endSession(CallSid);
      if (session.dbId) {
        updateCall(CallSid, { status: 'abandoned' });
        addTranscript(session.dbId, 'assistant', getTimeoutGoodbye(lang));
      }
      return res.type('text/xml').send(endTwiml(getTimeoutGoodbye(lang), lang));
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

      } else if (collected.callType === 'message') {
        createDoctorMessage(callId, {
          name:           collected.name,
          phone:          collected.phone,
          messageContent: collected.messageContent,
          urgency:        collected.urgency,
        }, clinicId);
        sendDoctorMessageNotification(callId, { ...collected, language: ai.language }, clinic)
          .catch(e => console.error('[Email] doctor msg notify failed:', e.message));
      }
    } catch (err) {
      console.error(`[Webhook/${clinic.slug}] finalizeCall DB error:`, err.message);
    }
  }

  endSession(callSid);
  console.log(`[Webhook/${clinic.slug}] Call ${callSid} finalized — type=${collected.callType} lang=${ai.language}`);
}

module.exports = router;
