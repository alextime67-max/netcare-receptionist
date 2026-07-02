const crypto    = require('crypto');
const WebSocket = require('ws');
const { createCall, updateCall, addTranscript } = require('../database/db');

const REALTIME_MODEL = 'gpt-realtime';
const REALTIME_URL   = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

// ── One-time voice tokens for browser WebSocket auth ─────────────────────────

const _voiceTokens = new Map();

function generateVoiceToken(clinicId) {
  const token = crypto.randomBytes(16).toString('hex');
  _voiceTokens.set(token, { clinicId, expires: Date.now() + 60_000 });
  setTimeout(() => _voiceTokens.delete(token), 60_000);
  return token;
}

function consumeVoiceToken(token) {
  const data = _voiceTokens.get(token);
  if (!data) return null;
  _voiceTokens.delete(token);
  return data.expires > Date.now() ? data.clinicId : null;
}

// ── System prompt for Realtime API ───────────────────────────────────────────

// Returns "Buenos días." / "Buenas tardes." / "Buenas noches." (or English equivalents)
// based on the current hour in the clinic's configured timezone.
function getTimeBasedGreeting(clinic) {
  const tz   = clinic.timezone || 'America/New_York';
  const lang = clinic.openai_language || 'es';
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()),
    10
  );
  if (lang === 'es') {
    if (hour >= 5 && hour < 12)  return 'Buenos días.';
    if (hour >= 12 && hour < 18) return 'Buenas tardes.';
    return 'Buenas noches.';
  }
  if (hour >= 5 && hour < 12)  return 'Good morning.';
  if (hour >= 12 && hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function buildRealtimeInstructions(clinic, kb) {
  const name     = clinic.name || 'the clinic';
  const asstName = clinic.ai_assistant_name || 'Ana';
  const lang     = clinic.openai_language || 'es';

  // Time-based greeting prepended automatically — clinic does NOT write it manually.
  const timeGreeting = getTimeBasedGreeting(clinic);

  // Body of greeting configured in SuperAdmin → AI Settings → Greeting.
  // Falls back to a generic phrase if not set.
  const greetingEs = clinic.ai_greeting_es?.trim()
    || `Gracias por llamar. ¿En qué puedo ayudarle hoy?`;
  const greetingEn = clinic.ai_greeting_en?.trim()
    || `Thank you for calling. How may I help you today?`;
  const openingGreeting = `${timeGreeting} ${lang === 'es' ? greetingEs : greetingEn}`;

  const lines = [
    `You are ${asstName}, an experienced, warm receptionist at ${name}.`,
    `You have worked at this office for many years. Callers feel comfortable and at ease talking to you.`,
    `You sound like a real person — never robotic, never rushed, never scripted.`,
    ``,
    `OPENING GREETING — CRITICAL RULES (follow exactly):`,
    `1. Your very first response MUST be EXACTLY this phrase — word for word, nothing added, nothing removed:`,
    `   "${openingGreeting}"`,
    `2. After saying the greeting → STOP. Say NOTHING else. Go completely silent.`,
    `3. Wait for the patient to speak first. Do NOT generate any follow-up text, questions, or filler.`,
    `4. Do NOT say "Claro, con mucho gusto...", "Of course...", or any other phrase until the patient has told you what they need.`,
    `5. Do NOT assume the patient wants an appointment or any specific service.`,
    `6. Only respond when the patient has finished speaking.`,
    ``,
    `LANGUAGE — BILINGUAL AUTO-DETECT:`,
    `- Your greeting above is in ${lang === 'es' ? 'Spanish' : 'English'} (the clinic's primary language).`,
    `- The moment the patient speaks, detect their language from their first words.`,
    `- If they speak ${lang === 'es' ? 'English' : 'Spanish'}: switch entirely to that language immediately and stay in it.`,
    `- If they speak ${lang === 'es' ? 'Spanish' : 'English'}: continue in ${lang === 'es' ? 'Spanish' : 'English'}.`,
    `- If they switch languages mid-call: match them instantly, no comment needed.`,
    `- NEVER ask "¿Prefiere español o inglés?" or "Do you prefer Spanish or English?" — just detect and respond.`,
    ``,
    lang === 'es'
      ? `Natural Spanish phrases (use sparingly): "Con mucho gusto.", "Claro, cómo no.", "Permítame un momento.", "No se preocupe, yo le ayudo.", "Perfecto.", "Déjeme confirmar.", "Entendido.", "Claro que sí."\nNatural English phrases when caller switches (use sparingly): "Of course.", "Absolutely.", "Let me confirm that.", "Got it.", "No worries.", "You're all set."`
      : `Natural English phrases (use sparingly): "Of course.", "Absolutely, I can help with that.", "Let me confirm that.", "Got it, thank you.", "No worries.", "You're all set."\nNatural Spanish phrases when caller switches (use sparingly): "Con mucho gusto.", "Claro, cómo no.", "Permítame un momento.", "No se preocupe.", "Perfecto.", "Entendido."`,
    ``,
    `CONVERSATION STYLE:`,
    `- Short responses — 1 to 2 natural sentences on the phone`,
    `- Ask only one question per turn`,
    `- Always wait for the patient to finish speaking before you respond`,
    `- Never say "Claro, con mucho gusto...", "Of course...", or similar until after the patient has stated their need`,
    `- Never assume or guess what the patient wants — always listen first`,
    `- Remember everything the caller tells you — NEVER ask again for information already given`,
    `- With elderly or slow callers: shorter sentences, confirm each item, say "No hay prisa." / "Take your time."`,
    ``,
    `COLLECT (in natural conversation, not as a form):`,
    `1. Caller full name — confirm warmly after they give it`,
    `   ${lang === 'es' ? 'Spanish: "Perfecto, le tengo como [Nombre] — ¿es correcto?"' : 'English: "Perfect, I have you as [Name] — is that right?"'}`,
    `2. Best callback phone number — confirm digit by digit`,
    `3. Request type: APPOINTMENT or MESSAGE`,
    `   • APPOINTMENT → preferred date, time, brief reason`,
    `   • MESSAGE → message content and urgency`,
    ``,
    `WHEN YOU DON'T KNOW — never invent or guess:`,
    lang === 'es'
      ? `"No tengo esa información disponible, pero puedo tomar nota para que alguien le llame. ¿Le parece bien?"`
      : `"I don't have that information available right now, but I can have someone from our office call you back. Would that work?"`,
    ``,
    `EMERGENCY — If caller mentions chest pain, difficulty breathing, stroke, overdose, or any life-threatening situation:`,
    lang === 'es'
      ? `Immediately say: "Esto es una emergencia. Por favor cuelgue y llame al 9-1-1 inmediatamente." Then end the conversation.`
      : `Immediately say: "This is a medical emergency. Please hang up and call 9-1-1 right away." Then end the conversation.`,
    ``,
    `GOODBYE — warm, never abrupt:`,
    lang === 'es'
      ? `"Perfecto, ya quedó todo anotado. Que tenga un excelente día. ¡Hasta luego!"`
      : `"All set! We'll be in touch soon. Have a wonderful day. Goodbye!"`,
  ];

  // Inject KB knowledge if available
  if (kb) {
    const kbFields = [
      ['SERVICES',            kb.services],
      ['OFFICE HOURS',        kb.office_hours],
      ['LOCATIONS',           kb.locations],
      ['INSURANCE ACCEPTED',  kb.insurance],
      ['DOCTORS / PROVIDERS', kb.doctors],
      ['APPOINTMENT POLICY',  kb.appointment_policy],
      ['CANCELLATION POLICY', kb.cancellation_policy],
      ['NEW PATIENT INFO',    kb.new_patient_requirements],
      ['DOCUMENTS NEEDED',    kb.documents_needed],
      ['FAQ',                 kb.faqs],
      ['TRANSFER RULES',      kb.transfer_rules],
      ['EMERGENCY PROTOCOL',  kb.emergency_instructions],
    ];
    const kbBody = kbFields.filter(([, v]) => v).map(([k, v]) => `${k}:\n${v}`).join('\n\n');
    if (kbBody) {
      lines.push('', '════════════════════', 'BUSINESS KNOWLEDGE — use this to answer caller questions accurately:', '════════════════════', kbBody);
    }
    if (kb.do_not_answer) {
      lines.push('', `DO NOT DISCUSS: ${kb.do_not_answer}`);
    }
  }

  // Inject AI config knowledge (legacy fields)
  const cfgFields = [
    ['ABOUT THIS BUSINESS', clinic.ai_business_description],
    ['SERVICES',            clinic.ai_services],
    ['OFFICE HOURS',        clinic.ai_office_hours],
    ['APPOINTMENT INFO',    clinic.ai_appointment_instructions],
    ['AFTER HOURS',         clinic.ai_after_hours_message],
    ['TRANSFER RULES',      clinic.ai_transfer_rules],
    ['EMERGENCY',           clinic.ai_emergency_instructions],
    ['ADDITIONAL KNOWLEDGE', clinic.ai_training_notes],
  ];
  const cfgBody = cfgFields.filter(([, v]) => v && v.trim()).map(([k, v]) => `${k}:\n${v.trim()}`).join('\n\n');
  if (cfgBody) lines.push('', cfgBody);

  // Business rules from Training Center
  const rules = kb?.businessRules || [];
  if (rules.length) {
    lines.push(
      '', '════════════════════',
      'BUSINESS RULES — follow these exactly on every call:',
      '════════════════════',
      ...rules.map(r => `• ${r.rule_text}`)
    );
  }

  // Trained FAQs from Training Center
  const trainingFaqs = kb?.trainingFaqs || [];
  if (trainingFaqs.length) {
    lines.push(
      '', '════════════════════',
      'FREQUENTLY ASKED QUESTIONS — use these exact answers when the topic comes up:',
      '════════════════════',
      ...trainingFaqs.flatMap(f => [`Q: ${f.question}`, `A: ${f.answer}`, ''])
    );
  }

  // Master prompt override — placed last so it always takes effect
  if (clinic.ai_master_prompt?.trim()) {
    lines.push(
      '', '════════════════════',
      'OVERRIDE INSTRUCTIONS — highest priority, always follow these:',
      '════════════════════',
      clinic.ai_master_prompt.trim()
    );
  }

  return lines.join('\n');
}

// ── Create ephemeral session token (for browser WebRTC) ──────────────────────

async function createEphemeralSession(apiKey, clinic, kb) {
  const instructions = buildRealtimeInstructions(clinic, kb);
  const voice        = clinic.openai_voice || 'coral';

  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'OpenAI-Beta':   'realtime=v1',
    },
    body: JSON.stringify({
      model: REALTIME_MODEL,
      voice,
      instructions,
      input_audio_format:  'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: {
        type:                 'server_vad',
        threshold:            0.5,
        prefix_padding_ms:    300,
        silence_duration_ms:  700,
      },
      temperature: 0.8,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI ${res.status}`);
  return data;
}

// ── Twilio Media Streams → OpenAI Realtime relay (server-side WebSocket) ─────

function createTwilioRelay(twilioWs, apiKey, clinic, kb) {
  const instructions = buildRealtimeInstructions(clinic, kb);
  const voice        = clinic.openai_voice || 'coral';
  const clinicName   = clinic.name || 'the clinic';

  const openaiWs = new WebSocket(REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let streamSid         = null;
  let callSid           = null;
  let dbId              = null;
  let sessionReady      = false;
  let greetingTriggered = false;
  let greetingDone      = false; // blocks patient audio until Ana's opening is finished

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  // ── OpenAI WebSocket handlers ─────────────────────────────────────────────

  openaiWs.on('open', () => {
    console.log(`[Realtime:Twilio] OpenAI connected  clinic=${clinicName}`);
    sendToOpenAI({
      type: 'session.update',
      session: {
        type:         'realtime',
        instructions,
        audio: {
          input:  { format: { type: 'audio/pcmu' } },       // G.711 μ-law — Twilio native, no transcoding
          output: { format: { type: 'audio/pcmu' }, voice }, // Same for output → Twilio receives it directly
        },
      },
    });
  });

  openaiWs.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }

    if (evt.type === 'session.created') {
      console.log(`[Realtime:Twilio:${clinicName}] session.created`);
    }

    if (evt.type === 'session.updated') {
      const fmt   = evt.session?.audio?.input?.format?.type  || 'unknown';
      const outFmt= evt.session?.audio?.output?.format?.type || 'unknown';
      const v     = evt.session?.audio?.output?.voice         || voice;
      console.log(`[Realtime:Twilio:${clinicName}] session.updated  input=${fmt}  output=${outFmt}  voice=${v}`);
      sessionReady = true;
      // Do NOT flush pre-connection audio — Twilio sends noise before the patient speaks.
      // Flushing it would make VAD trigger a second response right after the greeting.
      if (!greetingTriggered) {
        greetingTriggered = true;
        sendToOpenAI({ type: 'response.create' });
      }
    }

    // Greeting is done — now the patient can speak and we will forward their audio.
    if (evt.type === 'response.done' && greetingTriggered && !greetingDone) {
      greetingDone = true;
      console.log(`[Realtime:Twilio:${clinicName}] Greeting done — listening for patient`);
    }

    // Forward Ana's pcmu audio directly to Twilio — no conversion needed
    if (evt.type === 'response.output_audio.delta' && evt.delta && streamSid) {
      try {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: evt.delta } }));
        }
      } catch { /* Twilio disconnected */ }
    }

    if (evt.type === 'response.output_audio_transcript.done') {
      const text = evt.transcript;
      console.log(`[Realtime:Twilio:${clinicName}] Ana: ${text}`);
      if (dbId && text) {
        try { addTranscript(dbId, 'assistant', text); } catch (e) {
          console.error(`[Realtime:Twilio:${clinicName}] transcript log error:`, e.message);
        }
      }
    }

    if (evt.type === 'error') {
      console.error(`[Realtime:Twilio:${clinicName}] OpenAI error:`, evt.error?.message, `(${evt.error?.code})`);
    }
  });

  openaiWs.on('error', e => console.error(`[Realtime:Twilio:${clinicName}] OpenAI WS error:`, e.message));

  openaiWs.on('close', () => {
    console.log(`[Realtime:Twilio:${clinicName}] OpenAI WS closed  callSid=${callSid || 'none'}`);
    if (callSid) {
      try { updateCall(callSid, { status: 'completed' }); } catch {}
    }
    try { twilioWs.close(); } catch {}
  });

  // ── Twilio WebSocket handlers ─────────────────────────────────────────────

  twilioWs.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'start') {
      streamSid        = msg.start?.streamSid || msg.streamSid;
      callSid          = msg.start?.callSid;
      const callerPhone = msg.start?.customParameters?.from || 'anonymous';
      console.log(`[Realtime:Twilio:${clinicName}] Stream started  callSid=${callSid}  from=${callerPhone}  streamSid=${streamSid}`);

      if (callSid) {
        try {
          dbId = createCall(callSid, callerPhone, clinic.id);
          console.log(`[Realtime:Twilio:${clinicName}] Call record created  dbId=${dbId}`);
        } catch (e) {
          console.error(`[Realtime:Twilio:${clinicName}] createCall error:`, e.message);
        }
      }
    }

    if (msg.event === 'media') {
      const audio = msg.media?.payload;
      if (!audio) return;
      // Only forward patient audio after Ana's greeting is complete.
      // Audio received before greetingDone is connection noise — discarding it
      // prevents VAD from triggering a second response without the patient speaking.
      if (greetingDone) {
        sendToOpenAI({ type: 'input_audio_buffer.append', audio });
      }
    }

    if (msg.event === 'stop') {
      console.log(`[Realtime:Twilio:${clinicName}] Twilio stream stopped  callSid=${callSid}`);
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on('close', () => {
    console.log(`[Realtime:Twilio:${clinicName}] Twilio WS disconnected  callSid=${callSid || 'none'}`);
    if (callSid) {
      try { updateCall(callSid, { status: 'completed' }); } catch {}
    }
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on('error', e => console.error(`[Realtime:Twilio:${clinicName}] Twilio WS error:`, e.message));
}

// ── Browser relay — WebSocket proxy (browser → our server → OpenAI) ──────────
// Browser connects to /realtime/browser/:token with a one-time voice token.
// We proxy all Realtime API events bidirectionally so the browser handles
// audio capture/playback via Web Audio API without ever seeing the API key.

function createBrowserRelay(browserWs, apiKey, clinic, kb) {
  const instructions = buildRealtimeInstructions(clinic, kb);
  const voice        = clinic.openai_voice || 'coral';
  const clinicName   = clinic.name || 'the clinic';

  const openaiWs = new WebSocket(REALTIME_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let greetingTriggered = false;
  let greetingDone      = false; // blocks patient audio until Ana's opening is finished

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  openaiWs.on('open', () => {
    console.log(`[Realtime:Browser] Connected to OpenAI for ${clinicName}`);
    sendToOpenAI({
      type: 'session.update',
      session: {
        type:         'realtime',
        instructions,
        audio: { output: { voice } },
      },
    });
  });

  openaiWs.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }

    if (evt.type === 'session.updated' && !greetingTriggered) {
      greetingTriggered = true;
      sendToOpenAI({ type: 'response.create' });
    }

    // Greeting is done — now the patient can speak and we will forward their audio.
    if (evt.type === 'response.done' && greetingTriggered && !greetingDone) {
      greetingDone = true;
      console.log(`[Realtime:Browser:${clinicName}] Greeting done — listening for patient`);
    }

    if (evt.type === 'response.output_audio_transcript.done') {
      console.log(`[Realtime:Browser:${clinicName}] Ana: ${evt.transcript}`);
    }
    if (evt.type === 'error') {
      console.error(`[Realtime:Browser:${clinicName}] Error:`, evt.error?.message);
    }

    // Send as UTF-8 text so the browser receives a string (not a Blob) and JSON.parse succeeds
    try { if (browserWs.readyState === WebSocket.OPEN) browserWs.send(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw); } catch {}
  });

  openaiWs.on('error', e => console.error(`[Realtime:Browser:${clinicName}] WS error:`, e.message));
  openaiWs.on('close', () => {
    console.log(`[Realtime:Browser:${clinicName}] OpenAI closed`);
    try { browserWs.close(); } catch {}
  });

  browserWs.on('message', (raw, isBinary) => {
    try {
      const str = !isBinary && Buffer.isBuffer(raw) ? raw.toString('utf8') : (Buffer.isBuffer(raw) ? raw : raw);
      // Block patient audio until Ana's greeting is complete (same logic as Twilio relay).
      if (!greetingDone && !isBinary) {
        const msg = JSON.parse(typeof str === 'string' ? str : str.toString('utf8'));
        if (msg.type === 'input_audio_buffer.append') return;
      }
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(str);
    } catch {}
  });
  browserWs.on('close', () => {
    console.log(`[Realtime:Browser:${clinicName}] Browser disconnected`);
    try { openaiWs.close(); } catch {}
  });
  browserWs.on('error', e => console.error(`[Realtime:Browser:${clinicName}] Browser WS error:`, e.message));
}

module.exports = {
  buildRealtimeInstructions,
  createEphemeralSession,
  createTwilioRelay,
  createBrowserRelay,
  generateVoiceToken,
  consumeVoiceToken,
};
