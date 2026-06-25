const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');

const {
  initSession, getSession, setSessionDbId, endSession,
  setSelectedCenter, setSessionLanguage, incrementIvrTimeouts,
  processMessage, prewarmSession,
  getInitialGreeting, getNoInputMessage, getTimeoutGoodbye,
} = require('../services/ai');

const {
  createCall, updateCall, addTranscript,
  createAppointment, updateAppointmentSmsStatus, createDoctorMessage, getCallByCallSid,
  getClinicBySlug, getKnowledgeBase, logUnansweredQuestion,
} = require('../database/db');

const { sendAppointmentNotification, sendDoctorMessageNotification, sendEmergencyAlert } = require('../services/email');
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

function gatherTwiml(speakText, lang, slug, clinic) {
  const voice    = lang === 'es'
    ? (clinic?.ai_voice_es || 'Polly.Lupe-Neural')
    : (clinic?.ai_voice_en || 'Polly.Joanna');
  const langCode = lang === 'es' ? 'es-US' : 'en-US';
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

function endTwiml(speakText, lang, clinic) {
  const voice    = lang === 'es'
    ? (clinic?.ai_voice_es || 'Polly.Lupe-Neural')
    : (clinic?.ai_voice_en || 'Polly.Joanna');
  const langCode = lang === 'es' ? 'es-US' : 'en-US';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  <Hangup/>
</Response>`;
}

function transferTwiml(speakText, lang, transferPhone, callerPhone, clinic) {
  const voice    = lang === 'es'
    ? (clinic?.ai_voice_es || 'Polly.Lupe-Neural')
    : (clinic?.ai_voice_en || 'Polly.Joanna');
  const langCode = lang === 'es' ? 'es-US' : 'en-US';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langCode}">${esc(speakText)}</Say>
  <Dial timeout="30" callerId="${esc(callerPhone || '')}">${esc(transferPhone)}</Dial>
</Response>`;
}

function voicemailTwiml(speakText, lang, slug, clinic) {
  const voice    = lang === 'es'
    ? (clinic?.ai_voice_es || 'Polly.Lupe-Neural')
    : (clinic?.ai_voice_en || 'Polly.Joanna');
  const langCode = lang === 'es' ? 'es-US' : 'en-US';
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

// Waiting prompt: plays while AI is processing, then redirects to /gather-resume
function waitingTwiml(text, lang, slug, clinic) {
  const voice    = lang === 'es'
    ? (clinic?.ai_voice_es || 'Polly.Lupe-Neural')
    : (clinic?.ai_voice_en || 'Polly.Joanna');
  const langCode = lang === 'es' ? 'es-US' : 'en-US';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${langCode}">${esc(text)}</Say>
  <Redirect method="POST">/webhook/${slug}/gather-resume</Redirect>
</Response>`;
}

const WAITING_PROMPTS = {
  es: [
    'Con mucho gusto, un momento por favor.',
    'Permítame un momento.',
    'Claro que sí, enseguida le atiendo.',
    'Gracias por su paciencia.',
  ],
  en: [
    'Absolutely, just one moment please.',
    'Of course, let me check that for you.',
    'Sure, one moment.',
    'Thank you for your patience.',
  ],
};

function pickWaitingPrompt(lang) {
  const list = WAITING_PROMPTS[lang] || WAITING_PROMPTS.en;
  return list[Math.floor(Math.random() * list.length)];
}

// In-flight AI promises awaiting /gather-resume pickup
// callSid → { promise, result, speechResult }
const pendingResponses = new Map();

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
    ai = await Promise.race([
      aiPromise,
      new Promise((_, reject) =>
        setTimeout(() => { const e = new Error('threshold'); e.code = 'THRESHOLD'; reject(e); }, WAIT_THRESHOLD_MS)
      ),
    ]);
  } catch (err) {
    if (err.code === 'THRESHOLD') {
      timedOut = true;
    } else {
      // Real AI error — surface to caller
      console.error(`[Webhook/${clinic.slug}] gather AI error:`, err);
      const lang = session.language || 'es';
      return res.type('text/xml').send(gatherTwiml(
        lang === 'es'
          ? 'Disculpe, tuve un pequeño problema técnico. ¿Podría repetir eso?'
          : "I apologize, I had a small technical issue. Could you please repeat that?",
        lang, clinic.slug, clinic
      ));
    }
  }

  if (timedOut) {
    // AI is still processing — play waiting prompt and hand off to /gather-resume
    const lang = session.language || 'es';
    pendingResponses.set(CallSid, { promise: aiPromise, result: null, speechResult: SpeechResult });
    // Resolve the result into the entry as soon as it arrives
    aiPromise
      .then(result => { const e = pendingResponses.get(CallSid); if (e) e.result = result; })
      .catch(() => { /* handled in /gather-resume */ });
    const prompt = pickWaitingPrompt(lang);
    console.log(`[Latency] gather→waiting prompt  pre-ai=${Date.now()-t0}ms  CallSid=${CallSid}`);
    return res.type('text/xml').send(waitingTwiml(prompt, lang, clinic.slug, clinic));
  }

  // AI responded within threshold — send immediately, no waiting prompt
  const tAiDone = Date.now();
  res.on('finish', () =>
    console.log(`[Latency] gather total=${Date.now()-t0}ms ai=${tAiDone-tAiStart}ms post-ai=${Date.now()-tAiDone}ms  CallSid=${CallSid}`)
  );
  return sendAiResponse(ai, session, clinic, CallSid, SpeechResult, res);
});

// ── Route: waiting-prompt resume ──────────────────────────────────────────────

router.post('/:slug/gather-resume', clinicMiddleware, async (req, res) => {
  const t0 = Date.now();
  const { CallSid } = req.body;
  const clinic  = req.clinic;
  const session = getSession(CallSid);

  if (!session) {
    return res.type('text/xml').send(
      endTwiml(`Perdimos su sesión. Por favor llame nuevamente. Gracias por llamar a ${clinic.name}.`, 'es', clinic)
    );
  }

  const entry = pendingResponses.get(CallSid);
  if (!entry) {
    // Entry missing — recover gracefully
    const lang = session.language || 'es';
    return res.type('text/xml').send(gatherTwiml(
      lang === 'es' ? '¿Cómo puedo ayudarle?' : 'How may I assist you?',
      lang, clinic.slug, clinic
    ));
  }

  let ai;
  try {
    // By now the waiting prompt has played (~3–5 s); the AI is almost always done
    ai = entry.result || await entry.promise;
    pendingResponses.delete(CallSid);
  } catch (err) {
    pendingResponses.delete(CallSid);
    console.error(`[Webhook/${clinic.slug}] gather-resume error:`, err);
    const lang = session.language || 'es';
    return res.type('text/xml').send(gatherTwiml(
      lang === 'es'
        ? 'Disculpe, tuve un pequeño problema técnico. ¿Podría repetir eso?'
        : "I apologize, I had a small technical issue. Could you please repeat that?",
      lang, clinic.slug, clinic
    ));
  }

  const tAiDone = Date.now();
  console.log(`[Latency] gather-resume ai-wait=${tAiDone - t0}ms  CallSid=${CallSid}`);
  res.on('finish', () =>
    console.log(`[Latency] gather-resume total=${Date.now()-t0}ms  CallSid=${CallSid}`)
  );
  return sendAiResponse(ai, session, clinic, CallSid, entry.speechResult || '', res);
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
      return res.type('text/xml').send(endTwiml(getTimeoutGoodbye(lang, clinic.name), lang, clinic));
    }

    // On 2nd silence, offer voicemail
    if (session.silenceCount === 2) {
      const prompt = lang === 'es'
        ? 'No hemos recibido respuesta. Después del tono puede dejar un mensaje detallando su problema. Presione # cuando termine.'
        : "We didn't receive a response. After the beep, please leave a message describing your issue. Press # when done.";
      if (session.dbId) addTranscript(session.dbId, 'assistant', prompt);
      return res.type('text/xml').send(voicemailTwiml(prompt, lang, clinic.slug, clinic));
    }
  }

  res.type('text/xml').send(gatherTwiml(getNoInputMessage(lang), lang, clinic.slug, clinic));
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

// ── OpenAI Realtime Voice — Twilio Media Streams TwiML ───────────────────────
// Set this URL as the Twilio webhook for a phone number to use OpenAI Realtime.
// Requires APP_URL to be set to your public HTTPS/WSS domain (e.g. ngrok URL).

router.post('/:slug/realtime-voice', (req, res) => {
  const clinic = getClinicBySlug(req.params.slug);
  if (!clinic) return res.status(404).type('text/plain').send('Clinic not found');

  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${appUrl}/realtime/twilio/${clinic.slug}"/>
  </Connect>
</Response>`);
});

module.exports = router;
