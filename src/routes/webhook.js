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
} = require('../database/db');

const { sendAppointmentNotification, sendDoctorMessageNotification } = require('../services/email');

// ── Twilio request signature validation (enable with TWILIO_VALIDATE=true) ────

router.use((req, res, next) => {
  if (process.env.TWILIO_VALIDATE !== 'true') return next();

  const token  = process.env.TWILIO_AUTH_TOKEN;
  const appUrl = process.env.APP_URL;
  if (!token || !appUrl) return next();

  const signature = req.headers['x-twilio-signature'] || '';
  const url       = `${appUrl.replace(/\/$/, '')}${req.originalUrl}`;

  if (!twilio.validateRequest(token, signature, url, req.body)) {
    console.warn(`[Webhook] Rejected request with invalid Twilio signature — ${req.originalUrl}`);
    return res.status(403).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized</Say></Response>'
    );
  }
  next();
});

// ── TwiML helpers ─────────────────────────────────────────────────────────────

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function gatherTwiml(speakText, lang) {
  const voice    = lang === 'es' ? 'Polly.Lupe'   : 'Polly.Joanna';
  const langCode = lang === 'es' ? 'es-US'        : 'en-US';
  const hints    = lang === 'es'
    ? 'cita,doctor,mensaje,sí,no,urgente,urgente,nombre,apellido,teléfono,fecha,hora'
    : 'appointment,doctor,message,yes,no,urgent,name,phone,date,time,morning,afternoon';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/webhook/gather" method="POST"
          speechTimeout="4" speechModel="phone_call"
          language="${langCode}" hints="${esc(hints)}">
    <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/no-input</Redirect>
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

// ── Route: initial inbound call ───────────────────────────────────────────────

router.post('/voice', (req, res) => {
  const { CallSid, From } = req.body;
  console.log(`[Webhook] Inbound call  CallSid=${CallSid}  From=${From}`);

  initSession(CallSid, From);
  const dbId = createCall(CallSid, From);
  setSessionDbId(CallSid, dbId);

  const greeting = getInitialGreeting();
  addTranscript(dbId, 'assistant', greeting);

  res.type('text/xml').send(gatherTwiml(greeting, 'en'));
});

// ── Route: speech gathered ────────────────────────────────────────────────────

router.post('/gather', async (req, res) => {
  const { CallSid, SpeechResult = '', Confidence } = req.body;
  console.log(`[Webhook] Gather  CallSid=${CallSid}  speech="${SpeechResult}"  conf=${Confidence}`);

  const session = getSession(CallSid);
  if (!session) {
    return res.type('text/xml').send(
      endTwiml('We lost your session. Please call back. Thank you for calling NetCare.', 'en')
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
        patient_name:      ai.collected.name,
        patient_phone:     ai.collected.phone,
        call_type:         ai.collected.callType || 'unknown',
        language:          ai.language,
        emergency_detected: ai.emergencyDetected ? 1 : 0,
      });
    }

    if (ai.complete) {
      await finalizeCall(CallSid, ai);
      return res.type('text/xml').send(endTwiml(ai.speak, ai.language));
    }

    res.type('text/xml').send(gatherTwiml(ai.speak, ai.language));
  } catch (err) {
    console.error('[Webhook] gather error:', err);
    const lang = session.language || 'en';
    res.type('text/xml').send(gatherTwiml(
      lang === 'es'
        ? 'Lo siento, tuve un problema técnico. ¿Podría repetir eso?'
        : "I'm sorry, I had a technical issue. Could you please repeat that?",
      lang
    ));
  }
});

// ── Route: caller said nothing ────────────────────────────────────────────────

router.post('/no-input', (req, res) => {
  const { CallSid } = req.body;
  const session = getSession(CallSid);
  const lang = session?.language || 'en';

  // Track silence count to hang up after 3 silences
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

  res.type('text/xml').send(gatherTwiml(getNoInputMessage(lang), lang));
});

// ── Route: Twilio status callback ─────────────────────────────────────────────

router.post('/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(`[Webhook] Status  CallSid=${CallSid}  status=${CallStatus}  duration=${CallDuration}s`);

  try {
    const call = getCallByCallSid(CallSid);
    if (call) {
      const terminalStatuses = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];
      if (terminalStatuses.includes(CallStatus)) {
        updateCall(CallSid, {
          duration: CallDuration ? parseInt(CallDuration, 10) : null,
          status:   call.status === 'in_progress' ? 'abandoned' : call.status,
        });
        endSession(CallSid);
      }
    }
  } catch (err) {
    console.error('[Webhook] status callback error:', err.message);
  }

  res.status(204).send();
});

// ── Internal: finalize completed call ─────────────────────────────────────────

async function finalizeCall(callSid, ai) {
  const session = getSession(callSid);
  if (!session?.dbId) return;

  const { collected } = ai;
  const callId = session.dbId;

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
        });
        sendAppointmentNotification(callId, { ...collected, language: ai.language })
          .catch(e => console.error('[Email] appointment notify failed:', e.message));

      } else if (collected.callType === 'message') {
        createDoctorMessage(callId, {
          name:           collected.name,
          phone:          collected.phone,
          messageContent: collected.messageContent,
          urgency:        collected.urgency,
        });
        sendDoctorMessageNotification(callId, { ...collected, language: ai.language })
          .catch(e => console.error('[Email] doctor msg notify failed:', e.message));
      }
    } catch (err) {
      console.error('[Webhook] finalizeCall DB error:', err.message);
    }
  }

  endSession(callSid);
  console.log(`[Webhook] Call ${callSid} finalized — type=${collected.callType} lang=${ai.language}`);
}

module.exports = router;
