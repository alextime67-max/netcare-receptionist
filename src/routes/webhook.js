'use strict';
const express = require('express');
const router  = express.Router();

const { getClinicByTelnyxPhone } = require('../database/db');
const { getTelnyxRelay }         = require('../services/realtime');

// ── Telnyx Call Control helpers ───────────────────────────────────────────────

const TELNYX_API = 'https://api.telnyx.com/v2';

function telnyxPost(path, body) {
  return fetch(`${TELNYX_API}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function answerCall(callControlId) {
  const r = await telnyxPost(`/calls/${callControlId}/actions/answer`, {});
  if (!r.ok) console.error(`[Telnyx] answer failed: ${r.status} ${await r.text().catch(() => '')}`);
}

async function startStreaming(callControlId, streamUrl) {
  const r = await telnyxPost(`/calls/${callControlId}/actions/streaming_start`, {
    stream_url:   streamUrl,
    stream_track: 'both_tracks',
  });
  if (!r.ok) console.error(`[Telnyx] streaming_start failed: ${r.status} ${await r.text().catch(() => '')}`);
}

async function hangupCall(callControlId) {
  await telnyxPost(`/calls/${callControlId}/actions/hangup`, {}).catch(() => {});
}

async function startTranscription(callControlId) {
  const r = await telnyxPost(`/calls/${callControlId}/actions/transcription_start`, {
    transcription_engine: 'A',
    transcription_tracks: 'inbound_track',
  });
  if (!r.ok) console.error(`[Telnyx] transcription_start failed: ${r.status} ${await r.text().catch(() => '')}`);
}

// ── Telnyx webhook entry point ────────────────────────────────────────────────
// Configured in Telnyx portal as: POST https://netcarephone.com/telnyx/webhook

router.post('/webhook', async (req, res) => {
  // Always respond 200 immediately — Telnyx retries if it doesn't get a fast 2xx
  res.sendStatus(200);

  const payload = req.body?.data;
  if (!payload) return;

  const eventType     = payload.event_type;
  const p             = payload.payload || {};
  const callControlId = p.call_control_id;
  const from          = p.from;
  const to            = p.to;

function ivrLanguageMenuTwiml(clinic, slug) {
  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }
  const lm       = cfg?.languageMenu || {};
  const greeting = lm.greeting || `Gracias por comunicarse con ${clinic.name}.`;
  const voice    = lm.voice    || 'Polly.Lupe-Neural';
  const langCode = lm.langCode || 'es-US';
  const repText  = lm.repeatDigit
    ? `Para repetir, oprima ${lm.repeatDigit}. To repeat, press ${lm.repeatDigit}.`
    : '';
  const fullText = [
    greeting,
    'Para español, oprima 1. For English, press 2.',
    repText,
  ].filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" action="/webhook/${slug}/ivr-language-select" method="POST"
          numDigits="1" timeout="10">
    <Say voice="${voice}" language="${langCode}">${esc(fullText)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/${slug}/ivr-language</Redirect>
</Response>`;
}

function ivrMenuTwiml(clinic, slug, lang) {
  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }
  const useLang = lang || 'es';
  if (!cfg) {
    const greeting = getInitialGreeting(clinic);
    return gatherTwiml(greeting, useLang, slug, clinic);
  }
  const isEs     = useLang === 'es';
  const voice    = isEs ? 'Polly.Lupe-Neural'  : (cfg.voice    || 'Polly.Joanna');
  const langCode = isEs ? 'es-US'       : (cfg.language || 'en-US');
  const intro    = isEs ? 'Por favor seleccione su ubicación.' : 'Please select your location.';
  const optText  = isEs
    ? cfg.options.map(o => `Para ${o.label}, oprima ${o.digit}.`).join(' ')
    : cfg.options.map(o => `For ${o.label}, press ${o.digit}.`).join(' ');
  const repText  = cfg.repeatDigit
    ? (isEs ? `Para repetir, oprima ${cfg.repeatDigit}.` : `To repeat, press ${cfg.repeatDigit}.`)
    : '';
  const fullText = [intro, optText, repText].filter(Boolean).join(' ');
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
  next();
}

// ── Route: initial inbound call ───────────────────────────────────────────────

router.post('/:slug/voice', clinicMiddleware, (req, res) => {
  const t0 = Date.now();
  const { CallSid, From } = req.body;
  const clinic = req.clinic;
  console.log(`[Webhook/${clinic.slug}] Inbound call  CallSid=${CallSid}  From=${From}`);

  const kb = getKnowledgeBase(clinic.id);
  initSession(CallSid, From, clinic, kb);
  const dbId = createCall(CallSid, From, clinic.id);
  setSessionDbId(CallSid, dbId);

  if (clinic.ivr_enabled) {
    let cfg = null;
    try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }
    if (cfg?.languageMenu) {
      console.log(`[Webhook/${clinic.slug}] /voice → language-menu  ${Date.now() - t0}ms  CallSid=${CallSid}`);
      return res.type('text/xml').send(ivrLanguageMenuTwiml(clinic, clinic.slug));
    }
    console.log(`[Webhook/${clinic.slug}] /voice → ivr-menu  ${Date.now() - t0}ms  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug));
  }

  const greeting = getInitialGreeting(clinic);
  addTranscript(dbId, 'assistant', greeting);
  console.log(`[Webhook/${clinic.slug}] /voice → gather  ${Date.now() - t0}ms  CallSid=${CallSid}`);
  res.type('text/xml').send(gatherTwiml(greeting, 'es', clinic.slug, clinic));
});

// ── Route: IVR repeat / timeout ───────────────────────────────────────────────

router.post('/:slug/ivr-language', clinicMiddleware, (req, res) => {
  const { CallSid } = req.body;
  const clinic   = req.clinic;
  const timeouts = incrementIvrTimeouts(CallSid);
  const session  = getSession(CallSid);

  if (timeouts >= 2) {
    // Default to Spanish and proceed to location menu
    setSessionLanguage(CallSid, 'es');
    console.log(`[Webhook/${clinic.slug}] Language menu timeout×2 — defaulting Spanish  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug, 'es'));
  }

  console.log(`[Webhook/${clinic.slug}] Language menu repeat (timeout ${timeouts})  CallSid=${CallSid}`);
  res.type('text/xml').send(ivrLanguageMenuTwiml(clinic, clinic.slug));
});

router.post('/:slug/ivr-language-select', clinicMiddleware, (req, res) => {
  const t0 = Date.now();
  const { CallSid, Digits } = req.body;
  const clinic  = req.clinic;

  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }
  const lm = cfg?.languageMenu;

  if (!lm || !Digits) {
    return res.type('text/xml').send(ivrLanguageMenuTwiml(clinic, clinic.slug));
  }

  if (lm.repeatDigit && Digits === String(lm.repeatDigit)) {
    return res.type('text/xml').send(ivrLanguageMenuTwiml(clinic, clinic.slug));
  }

  const langOption = lm.options?.find(o => String(o.digit) === String(Digits));
  if (!langOption) {
    console.log(`[Webhook/${clinic.slug}] Language menu invalid digit=${Digits}  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrLanguageMenuTwiml(clinic, clinic.slug));
  }

  setSessionLanguage(CallSid, langOption.lang);
  console.log(`[Webhook/${clinic.slug}] /ivr-language-select lang=${langOption.lang}  ${Date.now() - t0}ms  CallSid=${CallSid}`);
  res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug, langOption.lang));
});

router.post('/:slug/ivr', clinicMiddleware, (req, res) => {
  const { CallSid } = req.body;
  const clinic   = req.clinic;
  const timeouts = incrementIvrTimeouts(CallSid);
  const session  = getSession(CallSid);
  const lang     = session?.language || 'es';

  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }

  if (timeouts >= 2) {
    const isEs     = lang === 'es';
    const voice    = isEs ? 'Polly.Lupe-Neural'  : (cfg?.voice    || 'Polly.Joanna');
    const langCode = isEs ? 'es-US'       : (cfg?.language || 'en-US');
    const dispName = cfg?.clinicDisplayName || clinic.name;
    const greeting = isEs
      ? `Gracias por llamar a ${dispName}. Soy el asistente virtual. ¿En qué le puedo ayudar?`
      : `Thank you for calling ${dispName}. I am the virtual assistant. How may I assist you today?`;
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
  res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug, lang));
});

// ── Route: IVR digit selection ────────────────────────────────────────────────

router.post('/:slug/ivr-select', clinicMiddleware, (req, res) => {
  const t0 = Date.now();
  const { CallSid, Digits } = req.body;
  const clinic  = req.clinic;
  const session = getSession(CallSid);
  const lang    = session?.language || 'es';

  let cfg = null;
  try { cfg = clinic.ivr_config ? JSON.parse(clinic.ivr_config) : null; } catch { cfg = null; }

  if (!cfg || !Digits) {
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug, lang));
  }

  const isEs     = lang === 'es';
  const voice    = isEs ? 'Polly.Lupe-Neural'  : (cfg.voice    || 'Polly.Joanna');
  const langCode = isEs ? 'es-US'       : (cfg.language || 'en-US');
  const dispName = cfg.clinicDisplayName || clinic.name;

  if (Digits === String(cfg.repeatDigit)) {
    console.log(`[Webhook/${clinic.slug}] IVR repeat requested  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug, lang));
  }

  const option = cfg.options.find(o => String(o.digit) === String(Digits));
  if (!option) {
    console.log(`[Webhook/${clinic.slug}] IVR invalid digit=${Digits}  CallSid=${CallSid}`);
    return res.type('text/xml').send(ivrMenuTwiml(clinic, clinic.slug, lang));
  }

  setSelectedCenter(CallSid, option);
  prewarmSession(CallSid); // build system prompt now while caller hears greeting + speaks
  const greeting = isEs
    ? `Con gusto le atiendo. Soy Ana, su asistente virtual de ${dispName} ${option.label}. ¿En qué le puedo ayudar hoy?`
    : `Thank you for calling ${dispName} ${option.label}. I'm Ana, your virtual assistant. How may I assist you today?`;
  if (session?.dbId) addTranscript(session.dbId, 'assistant', greeting);
  console.log(`[Webhook/${clinic.slug}] /ivr-select location=${option.label} lang=${lang}  ${Date.now() - t0}ms  CallSid=${CallSid}`);

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/webhook/${clinic.slug}/gather" method="POST"
          speechTimeout="4" speechModel="phone_call" language="${langCode}">
    <Say voice="${voice}" language="${langCode}">${esc(greeting)}</Say>
  </Gather>
  <Redirect method="POST">/webhook/${clinic.slug}/no-input</Redirect>
</Response>`);
});

// ── Shared: dispatch AI result to TwiML response ──────────────────────────────

async function sendAiResponse(ai, session, clinic, CallSid, speechResult, res) {
  if (session.dbId) {
    setImmediate(() => addTranscript(session.dbId, 'assistant', ai.speak));
    setImmediate(() => updateCall(CallSid, {
      patient_name:       ai.collected.name,
      patient_phone:      ai.collected.phone,
      call_type:          ai.collected.callType || 'unknown',
      language:           ai.language,
      emergency_detected: ai.emergencyDetected ? 1 : 0,
    }));
    if (ai.unanswered && speechResult) {
      setImmediate(() => {
        try { logUnansweredQuestion(clinic.id, session.dbId, speechResult); }
        catch (e) { console.error('[KB] logUnansweredQuestion error:', e.message); }
      });
    }
  }

  if (ai.transfer && clinic.transfer_phone) {
    if (session.dbId) {
      setImmediate(() => addTranscript(session.dbId, 'assistant', ai.speak));
      setImmediate(() => updateCall(CallSid, {
        patient_name:  ai.collected.name,
        patient_phone: ai.collected.phone,
        call_type:     'transfer',
        language:      ai.language,
        status:        'transferred',
      }));
    }
    endSession(CallSid);
    console.log(`[Webhook/${clinic.slug}] Transferring call ${CallSid} → ${clinic.transfer_phone}`);
    return res.type('text/xml').send(
      transferTwiml(ai.speak, ai.language, clinic.transfer_phone, clinic.twilio_phone, clinic)
    );
  }

  if (ai.complete) {
    await finalizeCall(CallSid, ai, clinic);
    return res.type('text/xml').send(endTwiml(ai.speak, ai.language, clinic));
  }

  return res.type('text/xml').send(gatherTwiml(ai.speak, ai.language, clinic.slug, clinic));
}

// ── Route: speech gathered ────────────────────────────────────────────────────

const WAIT_THRESHOLD_MS = 2000;

router.post('/:slug/gather', clinicMiddleware, async (req, res) => {
  const t0 = Date.now();
  const { CallSid, SpeechResult = '', Confidence } = req.body;
  const clinic = req.clinic;
  // STT is complete the moment this webhook fires (Twilio did STT before calling us)
  console.log(`[Latency] stt-complete  conf=${Confidence}  CallSid=${CallSid}`);
  console.log(`[Webhook/${clinic.slug}] Gather  CallSid=${CallSid}  speech="${SpeechResult}"`);

  const session = getSession(CallSid);
  if (!session) {
    return res.type('text/xml').send(
      endTwiml(`Perdimos su sesión. Por favor llame nuevamente. Gracias por llamar a ${clinic.name}.`, 'es', clinic)
    );
  }

  // Defer patient transcript write — does not affect TwiML response
  if (session.dbId && SpeechResult) {
    setImmediate(() => addTranscript(session.dbId, 'patient', SpeechResult));
  }

  const tAiStart = Date.now();
  console.log(`[Latency] gather pre-ai=${tAiStart - t0}ms  CallSid=${CallSid}`);

  // Start AI immediately; race against the 2-second waiting-prompt threshold
  const aiPromise = processMessage(CallSid, SpeechResult || '[silence]');
  let ai = null;
  let timedOut = false;

  try {
    // ── Inbound call: answer + start media streaming ──────────────────────────
    if (eventType === 'call.initiated' && p.direction === 'incoming') {
      if (!process.env.TELNYX_API_KEY) {
        console.error('[Telnyx] TELNYX_API_KEY not configured — cannot handle call');
        return;
      }

      const clinic = getClinicByTelnyxPhone(to);
      if (!clinic) {
        console.warn(`[Telnyx] No clinic configured for number ${to} — hanging up`);
        await hangupCall(callControlId);
        return;
      }
      if (clinic.status === 'suspended' || clinic.status === 'cancelled') {
        console.warn(`[Telnyx] Clinic ${clinic.slug} is ${clinic.status} — hanging up`);
        await hangupCall(callControlId);
        return;
      }

      console.log(`[Telnyx] Inbound call → clinic=${clinic.slug}  from=${from}`);

      await answerCall(callControlId);

      const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`)
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '');
      const streamUrl = `wss://${appUrl}/realtime/telnyx/${clinic.slug}`;

      await startStreaming(callControlId, streamUrl);
      console.log(`[Telnyx] Streaming started → ${streamUrl}`);

      // Start Telnyx server-side transcription for inbound audio
      await startTranscription(callControlId);
      console.log(`[Telnyx] Transcription started  ccid=${callControlId}`);

    // ── Call ended ────────────────────────────────────────────────────────────
    } else if (eventType === 'call.hangup') {
      console.log(`[Telnyx] Hangup  ccid=${callControlId}  cause=${p.hangup_cause || 'unknown'}`);
      // Relay cleanup is handled via WebSocket close event in createTelnyxRelay

    // ── Transcription result — route to relay ─────────────────────────────────
    } else if (eventType === 'call.transcription') {
      const td         = p.transcription_data || {};
      const transcript = (td.transcript || '').trim();
      const isFinal    = td.is_final === true;
      console.log(`[Telnyx] transcription  final=${isFinal}  text="${transcript}"`);
      if (isFinal && transcript) {
        const relay = getTelnyxRelay(callControlId);
        if (relay) {
          relay.onTranscription(transcript).catch(e =>
            console.error(`[Telnyx] onTranscription error:`, e.message)
          );
        } else {
          console.warn(`[Telnyx] No relay found for ccid=${callControlId} (transcription)`);
        }
      }

    // ── TTS lifecycle — route speak.ended to relay ────────────────────────────
    } else if (eventType === 'call.speak.started') {
      console.log(`[Telnyx] speak.started  ccid=${callControlId}`);

    } else if (eventType === 'call.speak.ended') {
      console.log(`[Telnyx] speak.ended  ccid=${callControlId}`);
      const relay = getTelnyxRelay(callControlId);
      if (relay) relay.onSpeakEnded();

    // ── Streaming lifecycle (informational) ───────────────────────────────────
    } else if (eventType === 'streaming.started') {
      console.log(`[Telnyx] Streaming confirmed started  ccid=${callControlId}`);

    } else if (eventType === 'streaming.stopped') {
      console.log(`[Telnyx] Streaming stopped  ccid=${callControlId}`);
    }

  } catch (err) {
    console.error(`[Telnyx] webhook handler error (${eventType}):`, err.message);
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
  res.type('text/xml').send(voicemailTwiml(prompt, lang, clinic.slug, clinic));
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

  res.type('text/xml').send(endTwiml(goodbye, lang, clinic));
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

  if (ai.emergencyDetected) {
    const callerPhone = ai.collected?.phone || session?.collected?.phone || 'unknown';
    sendEmergencyAlert(callId, callerPhone, clinic)
      .catch(e => console.error('[Email] Emergency alert failed:', e.message));
  }

  if (!ai.emergencyDetected) {
    try {
      if (collected.callType === 'appointment') {
        const apptId = createAppointment(callId, {
          name:            collected.name,
          phone:           collected.phone,
          appointmentDate: collected.appointmentDate,
          appointmentTime: collected.appointmentTime,
          reason:          collected.reason,
          location:        session.selectedCenter?.label || null,
        }, clinicId);
        sendAppointmentNotification(callId, { ...collected, language: ai.language }, clinic)
          .catch(e => console.error('[Email] appointment notify failed:', e.message));
        sendAppointmentConfirmationSms(
          clinic, collected.phone, collected.name,
          session.selectedCenter?.label || null,
          collected.appointmentDate, collected.appointmentTime, ai.language
        ).then(smsSid => {
          if (smsSid) updateAppointmentSmsStatus(apptId, 1);
          // null → Twilio not configured yet; leave sms_sent = 0
        }).catch(e => {
          console.error('[SMS] appointment SMS failed:', e.message);
          updateAppointmentSmsStatus(apptId, 2);
        });

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
