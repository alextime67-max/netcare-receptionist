'use strict';
const crypto    = require('crypto');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');
const { createCall, updateCall, addTranscript } = require('../database/db');

// ── Anthropic client (shared across all relay instances) ──────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TELNYX_API = 'https://api.telnyx.com/v2';

// ── One-time voice tokens for browser WebSocket auth ─────────────────────────

const _voiceTokens = new Map();

function generateVoiceToken(clinicId) {
  const token = crypto.randomBytes(16).toString('hex');
  _voiceTokens.set(token, { clinicId, expires: Date.now() + 300_000 }); // 5 min TTL
  setTimeout(() => _voiceTokens.delete(token), 300_000);
  return token;
}

function consumeVoiceToken(token) {
  const data = _voiceTokens.get(token);
  if (!data) return null;
  _voiceTokens.delete(token);
  return data.expires > Date.now() ? data.clinicId : null;
}

// ── Time-based greeting ───────────────────────────────────────────────────────

function getTimeBasedGreeting(clinic) {
  const tz   = clinic.timezone || 'America/New_York';
  const lang = clinic.ai_language || 'es';
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

// ── System prompt builder ─────────────────────────────────────────────────────

function buildRealtimeInstructions(clinic, kb) {
  const name     = clinic.name || 'the clinic';
  const asstName = clinic.ai_assistant_name || 'Ana';
  const lang     = clinic.ai_language || 'es';

  const timeGreeting = getTimeBasedGreeting(clinic);
  const greetingEs   = clinic.ai_greeting_es?.trim() || `Gracias por llamar. ¿En qué puedo ayudarle hoy?`;
  const greetingEn   = clinic.ai_greeting_en?.trim() || `Thank you for calling. How may I help you today?`;
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

  const rules = kb?.businessRules || [];
  if (rules.length) {
    lines.push(
      '', '════════════════════',
      'BUSINESS RULES — follow these exactly on every call:',
      '════════════════════',
      ...rules.map(r => `• ${r.rule_text}`)
    );
  }

  const trainingFaqs = kb?.trainingFaqs || [];
  if (trainingFaqs.length) {
    lines.push(
      '', '════════════════════',
      'FREQUENTLY ASKED QUESTIONS — use these exact answers when the topic comes up:',
      '════════════════════',
      ...trainingFaqs.flatMap(f => [`Q: ${f.question}`, `A: ${f.answer}`, ''])
    );
  }

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

// ── Telnyx relay registry ─────────────────────────────────────────────────────
// Maps callControlId → relay object. Webhook routes call.transcription and
// call.speak.ended to the active relay for that call.

const _telnyxRelays = new Map();

function getTelnyxRelay(callControlId) {
  return _telnyxRelays.get(callControlId) || null;
}

// ── Telnyx Call Control relay — pure REST, no WebSocket ──────────────────────
//
// State machine:
//   GREETING   — greeting TTS is playing; incoming transcripts are discarded
//   WAITING    — silent; accepts final transcripts from Telnyx STT
//   RESPONDING — Claude is processing + TTS is playing; transcripts discarded
//
// Created in call.answered. Webhook routes events here via getTelnyxRelay().

function createTelnyxRelay(callControlId, callerPhone, clinic, kb, apiKey, sttFallbackFn) {
  const clinicName = clinic.name || 'the clinic';
  const lang       = clinic.ai_language || 'es';
  // Full Telnyx Ultra voice IDs — override via clinic.ai_voice_es / ai_voice_en
  const voiceEs    = clinic.ai_voice_es || 'Telnyx.Ultra.f4d6bb07-f876-4464-ba70-cd48d8701890'; // Adriana
  const voiceEn    = clinic.ai_voice_en || 'Telnyx.Ultra.9626c31c-bec5-4cca-baa8-f8ba9e84c8bc'; // Jacqueline
  const voiceId    = lang === 'es' ? voiceEs : voiceEn;

  // JSON output format appended so Claude reports reply language for bilingual voice switching
  const instructions = buildRealtimeInstructions(clinic, kb) + `

════════════════════
OUTPUT FORMAT — MANDATORY (phone relay only):
Every reply MUST be a single-line JSON object — nothing before it, nothing after it:
  {"lang":"es","text":"Tu respuesta aquí"}
  {"lang":"en","text":"Your response here"}
"lang" : the language you are replying in — "es" or "en".
"text" : the exact words to speak — plain text, no markdown, no extra keys.
Do NOT wrap in code fences. Do NOT add any text outside the JSON.`;

  let state              = 'GREETING';
  let callEnded          = false;   // set true on hangup — blocks speak after call ends
  let lastSpeakCommandId = null;   // command_id of the most-recently accepted speak
  let dbId               = null;
  let callStart          = Date.now();
  let deepgramController = null;   // set by setDeepgramController() when Deepgram relay is active
  const history          = [];

  async function speak(text, activeVoice, activeLang) {
    if (callEnded) {
      console.warn(`[Telnyx/${clinicName}] speak skipped — call already ended`);
      return null;
    }
    const language  = activeLang === 'es' ? 'es-MX' : 'en-US';
    const commandId = crypto.randomUUID();
    const payload   = { payload: text, voice: activeVoice, language, payload_type: 'text', command_id: commandId };

    console.log(`[Telnyx/${clinicName}] SPEAK cmd=${commandId.slice(0, 8)}  voice=…${activeVoice.slice(-8)}  lang=${language}  state=${state}  "${text.slice(0, 80)}"`);
    console.log(`[Telnyx/${clinicName}] SPEAK payload: ${JSON.stringify(payload)}`);

    const r = await fetch(
      `${TELNYX_API}/calls/${encodeURIComponent(callControlId)}/actions/speak`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify(payload),
      }
    );

    const responseText = await r.text().catch(() => '(unreadable)');
    console.log(`[Telnyx/${clinicName}] SPEAK response: ${r.status}  body: ${responseText.slice(0, 300)}`);

    if (!r.ok) {
      console.error(`[Telnyx/${clinicName}] speak FAILED: ${r.status}  cmd=${commandId.slice(0, 8)}`);
      return null;
    }

    lastSpeakCommandId = commandId;
    console.log(`[Telnyx/${clinicName}] speak OK  cmd=${commandId.slice(0, 8)} → stored as lastSpeakCommandId`);
    return commandId;
  }

  const relay = {
    // Called after call.answered + transcription_start — plays the opening greeting
    async onCallAnswered() {
      const timeGreeting = getTimeBasedGreeting(clinic);
      const greetingEs   = clinic.ai_greeting_es?.trim() || 'Gracias por llamar. ¿En qué puedo ayudarle hoy?';
      const greetingEn   = clinic.ai_greeting_en?.trim() || 'Thank you for calling. How may I help you today?';
      const greeting     = `${timeGreeting} ${lang === 'es' ? greetingEs : greetingEn}`;

      history.push({ role: 'assistant', content: greeting });
      if (dbId) try { addTranscript(dbId, 'assistant', greeting); } catch {}

      console.log(`[Telnyx/${clinicName}] Greeting (state=GREETING): "${greeting}"`);
      const greetCmdId = await speak(greeting, voiceId, lang);
      if (!greetCmdId && !callEnded) {
        state = 'WAITING';
        console.warn(`[Telnyx/${clinicName}] Greeting speak failed → forced WAITING`);
      }
    },

    // Called by Telnyx call.transcription (Telnyx STT) OR deepgram-relay.js (Deepgram STT)
    // meta = { sttProvider, sttModel, confidence, turnIndex } — present only from Deepgram
    async onTranscription(text, meta = {}) {
      if (callEnded) {
        console.log(`[Telnyx/${clinicName}] transcript discarded — call already ended`);
        return;
      }
      const sttSrc  = meta.sttProvider || 'telnyx';
      const confStr = meta.confidence != null ? ` conf=${meta.confidence.toFixed(2)}` : '';
      console.log(`[Telnyx/${clinicName}] transcript [${sttSrc}]${confStr}  state=${state}  "${text.slice(0, 80)}"`);

      if (state !== 'WAITING') {
        console.log(`[Telnyx/${clinicName}] transcript discarded (state=${state}): "${text.slice(0, 40)}"`);
        return;
      }
      if (text.trim().length < 2) {
        console.log(`[Telnyx/${clinicName}] transcript too short, ignoring: "${text}"`);
        return;
      }

      console.log(`[Telnyx/${clinicName}] Patient said [${sttSrc}]: "${text}"`);
      console.log(`[TURN_LOG] ${JSON.stringify({
        event:       'patient_speech',
        clinic:      clinicName,
        sttProvider: sttSrc,
        sttModel:    meta.sttModel  || (sttSrc === 'deepgram' ? 'nova-3-medical' : 'telnyx-engine-b'),
        confidence:  meta.confidence ?? null,
        turnIndex:   meta.turnIndex  ?? null,
        text,
      })}`);
      if (dbId) try { addTranscript(dbId, 'patient', text); } catch {}

      state = 'RESPONDING';
      console.log(`[Telnyx/${clinicName}] state → RESPONDING  (calling Claude)`);
      history.push({ role: 'user', content: text });

      try {
        const t0  = Date.now();
        const msg = await anthropic.messages.create({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 350,
          system:     instructions,
          messages:   history,
        });
        console.log(`[Telnyx/${clinicName}] Claude responded in ${Date.now() - t0}ms`);

        const raw        = msg.content?.[0]?.text?.trim() || '';
        console.log(`[Telnyx/${clinicName}] Claude raw: "${raw.slice(0, 150)}"`);
        let reply        = raw;
        let detectedLang = lang;

        try {
          const parsed = JSON.parse(raw);
          if (parsed.text && typeof parsed.text === 'string') {
            reply        = parsed.text.trim();
            detectedLang = parsed.lang === 'en' ? 'en' : 'es';
          }
        } catch {
          console.warn(`[Telnyx/${clinicName}] JSON parse failed, using raw reply`);
        }

        if (!reply) {
          console.warn(`[Telnyx/${clinicName}] Claude returned empty reply`);
          state = 'WAITING';
          return;
        }

        const activeVoice = detectedLang === 'es' ? voiceEs : voiceEn;
        console.log(`[Telnyx/${clinicName}] Ana (${detectedLang}): "${reply}"`);
        history.push({ role: 'assistant', content: reply });
        if (dbId) try { addTranscript(dbId, 'assistant', reply); } catch {}

        if (callEnded) {
          console.warn(`[Telnyx/${clinicName}] Claude ready but call already ended — discarding reply`);
          return;
        }

        // 500 ms pause — lets any pending call.speak.ended from the greeting turn arrive
        // before we send the new speak, so stale events cannot stomp the new command_id
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log(`[Telnyx/${clinicName}] 500 ms pause done, sending speak  state=${state}`);

        const replyCmdId = await speak(reply, activeVoice, detectedLang);
        if (!replyCmdId && !callEnded) {
          state = 'WAITING';
          console.warn(`[Telnyx/${clinicName}] Response speak failed -> forced WAITING`);
        }
      } catch (err) {
        console.error(`[Telnyx/${clinicName}] Claude/speak error:`, err.message);
        state = 'WAITING';
      }
    },

    // Called when call.speak.ended fires — transitions to WAITING so next transcript is processed
    onSpeakEnded(eventCommandId) {
      const evtShort  = eventCommandId ? eventCommandId.slice(0, 8) : 'n/a';
      const lastShort = lastSpeakCommandId ? lastSpeakCommandId.slice(0, 8) : 'n/a';
      console.log(`[Telnyx/${clinicName}] speak.ended  event_cmd=${evtShort}  last_cmd=${lastShort}  state=${state}`);

      // Ignore stale call.speak.ended from a previous speak command
      if (eventCommandId && lastSpeakCommandId && eventCommandId !== lastSpeakCommandId) {
        console.warn(`[Telnyx/${clinicName}] speak.ended IGNORED — stale cmd (expected ${lastShort}, got ${evtShort})`);
        return;
      }

      const prev = state;
      if (state === 'GREETING' || state === 'RESPONDING') {
        state = 'WAITING';
        lastSpeakCommandId = null;
        console.log(`[Telnyx/${clinicName}] speak.ended: ${prev} -> WAITING  (ready for patient)`);
      } else {
        console.log(`[Telnyx/${clinicName}] speak.ended  state=${state} (no change)`);
      }
    },

    // Called by deepgram-relay.js when Deepgram fails — activates sttFallbackFn (Telnyx engine B)
    async onSttFallback(provider) {
      console.log(`[Telnyx/${clinicName}] onSttFallback → ${provider}`);
      if (callEnded) return;
      if (typeof sttFallbackFn === 'function') {
        try { await sttFallbackFn(); } catch (e) {
          console.error(`[Telnyx/${clinicName}] STT fallback error:`, e.message);
        }
      }
    },

    // Called from server.js after createDeepgramRelay() so cleanup() can close it on hangup
    setDeepgramController(controller) {
      deepgramController = controller;
      console.log(`[Telnyx/${clinicName}] Deepgram controller registered`);
    },

    // Called on call.hangup — saves duration + final status, unregisters relay
    cleanup() {
      callEnded = true;
      if (deepgramController) {
        try { deepgramController.close(); } catch {}
        deepgramController = null;
        console.log(`[Telnyx/${clinicName}] Deepgram relay closed on hangup`);
      }
      const duration = Math.round((Date.now() - callStart) / 1000);
      if (dbId) try { updateCall(callControlId, { status: 'completed', duration }); } catch {}
      _telnyxRelays.delete(callControlId);
      console.log(`[Telnyx/${clinicName}] Call ended  duration=${duration}s  turns=${history.length}`);
    },
  };

  // Register before returning so webhook can route events immediately
  _telnyxRelays.set(callControlId, relay);

  // Create DB call record (synchronous via better-sqlite3)
  try { dbId = createCall(callControlId, callerPhone, clinic.id); } catch (e) {
    console.error(`[Telnyx/${clinicName}] createCall error:`, e.message);
  }

  return relay;
}

// ── Browser relay — Claude text chat (SuperAdmin Live Voice / Test Ana) ───────
// Browser connects to /realtime/browser/:token via WebSocket.
// Protocol: browser → { type:'user_message', text }
//           server  → { type:'assistant_message', text } | { type:'session.created' }

function createBrowserRelay(browserWs, apiKey, clinic, kb) {
  const AnthropicLocal = require('@anthropic-ai/sdk');
  const instructions   = buildRealtimeInstructions(clinic, kb);
  const clinicName     = clinic.name || 'the clinic';
  const localAnthropic = new AnthropicLocal({ apiKey });

  const history = [];
  let   closed  = false;

  function send(obj) {
    if (!closed && browserWs.readyState === WebSocket.OPEN) {
      try { browserWs.send(JSON.stringify(obj)); } catch {}
    }
  }

  async function chat(userText) {
    history.push({ role: 'user', content: userText || '[BEGIN CALL]' });
    try {
      const res = await localAnthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 512,
        system:     instructions,
        messages:   history,
      });
      const text = res.content?.[0]?.text?.trim() || '';
      if (text) {
        history.push({ role: 'assistant', content: text });
        send({ type: 'assistant_message', text });
        console.log(`[Realtime:Browser:${clinicName}] Ana: ${text.slice(0, 120)}`);
      }
    } catch (e) {
      console.error(`[Realtime:Browser:${clinicName}] Anthropic error:`, e.message);
      send({ type: 'error', error: { message: e.message } });
    }
  }

  send({ type: 'session.created' });
  console.log(`[Realtime:Browser] Session created for ${clinicName}`);
  chat(null);

  browserWs.on('message', raw => {
    if (closed) return;
    try {
      const msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
      if (msg.type === 'user_message' && msg.text?.trim()) {
        console.log(`[Realtime:Browser:${clinicName}] User: ${msg.text.slice(0, 100)}`);
        chat(msg.text.trim());
      }
    } catch {}
  });

  browserWs.on('close', () => {
    closed = true;
    console.log(`[Realtime:Browser:${clinicName}] Browser disconnected`);
  });

  browserWs.on('error', e => console.error(`[Realtime:Browser:${clinicName}] WS error:`, e.message));
}

module.exports = {
  buildRealtimeInstructions,
  createTelnyxRelay,
  getTelnyxRelay,
  createBrowserRelay,
  generateVoiceToken,
  consumeVoiceToken,
  getTelnyxRelay,
};
