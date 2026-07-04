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

// ── PCM16 → G.711 μ-law conversion (for Twilio Media Streams) ───────────────

function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

// Converts base64 PCM16 at inputRate Hz → Buffer of μ-law bytes at 8kHz
function pcm16Base64ToMulaw8k(base64, inputRate = 24000) {
  const pcm    = Buffer.from(base64, 'base64');
  const ratio  = inputRate / 8000;                         // 3 for 24kHz, 2 for 16kHz
  const nIn    = Math.floor(pcm.length / 2);
  const nOut   = Math.floor(nIn / ratio);
  const out    = Buffer.alloc(nOut);
  for (let i = 0; i < nOut; i++) {
    const idx  = Math.floor(i * ratio) * 2;
    out[i]     = linearToMulaw(pcm.readInt16LE(idx));
  }
  return out;
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
  let greetingDone      = false; // true after first response.done (greeting complete)
  let greetingTriggered = false;

  // ── State machine ─────────────────────────────────────────────────────────
  // GREETING   — greeting playing; Ana's audio → Twilio; patient audio discarded
  // WAITING    — silence; NO audio to OpenAI; local energy detection only; Ana SILENT
  // FORWARDING — patient audio → OpenAI; accumulating; Ana SILENT
  // COMMITTED  — buffer committed; awaiting Whisper transcript; Ana SILENT
  // RESPONDING — Ana generating reply; Ana's audio → Twilio; patient audio discarded
  //
  // The ABSOLUTE rule: response.output_audio.delta is forwarded ONLY in GREETING or RESPONDING.
  // All other states: Ana's audio is silently discarded regardless of what OpenAI sends.
  let twilioState  = 'GREETING';
  let activeFrames = 0;   // consecutive high-energy frames (WAITING → FORWARDING onset)
  let silentFrames = 0;   // consecutive low-energy frames (FORWARDING → commit offset)
  let blockedCount = 0;   // throttle for periodic WAITING log
  let guardTimer   = null; // COMMITTED safety timeout — reset if no transcript arrives

  const SPEECH_ON_FRAMES  = 3;    //  3 × 20 ms = 60 ms sustained energy to start forwarding
  const SPEECH_OFF_FRAMES = 40;   // 40 × 20 ms = 800 ms silence to commit buffer
  const COMMITTED_TIMEOUT = 8000; // ms — safety reset if Whisper never responds

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  function clearBuffer() {
    sendToOpenAI({ type: 'input_audio_buffer.clear' });
  }

  function resetToWaiting(reason) {
    if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
    twilioState  = 'WAITING';
    activeFrames = 0;
    silentFrames = 0;
    clearBuffer();
    console.log(`[${clinicName}] twilio_waiting_for_user — ${reason}`);
  }

  // Variance-based G.711/PCMU speech detector — encoding-agnostic.
  // Silence: bytes cluster near one value (low variance ≈ 0–150).
  // Speech:  bytes span a wide range (high variance ≈ 800+).
  // This avoids wrong assumptions about whether silence is near 0x00 or 0xFF.
  function g711HasSpeech(base64Chunk) {
    const buf = Buffer.from(base64Chunk, 'base64');
    const n   = buf.length;
    if (n === 0) return false;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += buf[i];
    const mean = sum / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = buf[i] - mean; v += d * d; }
    v /= n;
    return v > 300;
  }

  // ── OpenAI WebSocket handlers ─────────────────────────────────────────────

  openaiWs.on('open', () => {
    console.log(`[${clinicName}] Twilio → OpenAI connected`);
    console.log(`[${clinicName}] instructions_preview: ${instructions.slice(0, 120).replace(/\n/g, ' ')}`);
    sendToOpenAI({
      type: 'session.update',
      session: {
        type:                'realtime',
        instructions,
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
      },
    });
    console.log(`[${clinicName}] session.update sent`);
  });

  openaiWs.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }

    console.log(`[${clinicName}] openai_event: ${evt.type}${evt.type === 'error' ? ' — ' + JSON.stringify(evt.error) : ''}`);

    if (evt.type === 'session.created') {
      console.log(`[${clinicName}] session.created — waiting for session.updated`);
    }

    if (evt.type === 'session.updated') {
      console.log(`[${clinicName}] session.updated voice=${evt.session?.voice || voice}`);
      if (!greetingTriggered) {
        greetingTriggered = true;
        // Inject system prompt as conversation item — gpt-realtime applies it before response
        sendToOpenAI({
          type: 'conversation.item.create',
          item: {
            type:    'message',
            role:    'system',
            content: [{ type: 'input_text', text: instructions }],
          },
        });
        console.log(`[${clinicName}] system instructions injected`);
        sendToOpenAI({ type: 'response.create' });
        console.log(`[${clinicName}] greeting triggered`);
      }
    }

    // ── ABSOLUTE gate: Ana's audio only reaches Twilio in GREETING or RESPONDING ─
    // Any audio event in WAITING / FORWARDING / COMMITTED is silently discarded.
    // This is the last line of defense — even if OpenAI generates audio unexpectedly,
    // the patient never hears it unless we deliberately entered RESPONDING state.
    if ((evt.type === 'response.output_audio.delta' || evt.type === 'response.audio.delta') && evt.delta && streamSid) {
      if (twilioState === 'GREETING' || twilioState === 'RESPONDING') {
        try {
          const mulaw   = pcm16Base64ToMulaw8k(evt.delta, 24000);
          const CHUNK   = 160; // 20 ms at 8kHz
          let   chunks  = 0;
          for (let off = 0; off < mulaw.length; off += CHUNK) {
            const slice = mulaw.slice(off, off + CHUNK);
            if (twilioWs.readyState === WebSocket.OPEN)
              twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: slice.toString('base64') } }));
            chunks++;
          }
          console.log(`[${clinicName}] audio_sent mulaw_bytes=${mulaw.length} chunks=${chunks}`);
        } catch (err) {
          console.error(`[${clinicName}] audio_convert_error: ${err.message}`);
        }
      }
      return;
    }

    // ── Ana finished a response ───────────────────────────────────────────────
    if (evt.type === 'response.done') {
      if (!greetingDone) {
        // First response.done ever = greeting complete
        greetingDone = true;
        console.log(`[${clinicName}] twilio_greeting_done`);
        resetToWaiting('greeting complete');
      } else if (twilioState === 'RESPONDING') {
        resetToWaiting('Ana response complete');
      }
      // response.done in other states (e.g. stray cancelled response) → ignore
    }

    // ── Authoritative gate: transcript required before any response ───────────
    // With VAD disabled, this event fires only after our manual input_audio_buffer.commit.
    // Whisper transcribes what the patient actually said. If the transcript is empty or
    // too short to be real speech (noise/echo committed by mistake), we reset silently.
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }

      const transcript = (evt.transcript || '').trim();
      const words      = transcript.split(/\s+/).filter(w => w.length > 1);
      console.log(`[${clinicName}] twilio_user_transcript_received: "${transcript}"  (${words.length} real words)`);

      if (words.length >= 2 && twilioState === 'COMMITTED') {
        // Real patient speech confirmed → generate Ana's response
        twilioState = 'RESPONDING';
        sendToOpenAI({ type: 'response.create' });
        console.log(`[${clinicName}] twilio_response_allowed`);
      } else {
        resetToWaiting(
          words.length < 2
            ? `transcript too short or noise: "${transcript}"`
            : `unexpected state ${twilioState} on transcript`
        );
      }
    }

    if (evt.type === 'response.output_audio_transcript.done') {
      const text = evt.transcript;
      console.log(`[${clinicName}] Ana: ${text}`);
      if (dbId && text) {
        try { addTranscript(dbId, 'assistant', text); } catch (e) {
          console.error(`[${clinicName}] transcript log error:`, e.message);
        }
      }
    }

    if (evt.type === 'error') {
      console.error(`[${clinicName}] OpenAI error:`, evt.error?.message, `(${evt.error?.code})`);
    }
  });

  openaiWs.on('error', e => console.error(`[Realtime:Twilio:${clinicName}] WS error:`, e.message));

  openaiWs.on('close', () => {
    if (guardTimer) clearTimeout(guardTimer);
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
      streamSid         = msg.start?.streamSid || msg.streamSid;
      callSid           = msg.start?.callSid;
      const callerPhone = msg.start?.customParameters?.from || 'anonymous';
      console.log(`[Realtime:Twilio:${clinicName}] Stream started  callSid=${callSid}  from=${callerPhone}`);
      if (callSid) {
        try {
          dbId = createCall(callSid, callerPhone, clinic.id);
        } catch (e) {
          console.error(`[Realtime:Twilio:${clinicName}] createCall error:`, e.message);
        }
      }
    }

    if (msg.event === 'media') {
      const audio = msg.media?.payload;
      if (!audio) return;

      // GREETING / RESPONDING / COMMITTED: discard all patient audio
      if (twilioState !== 'WAITING' && twilioState !== 'FORWARDING') return;

      if (twilioState === 'WAITING') {
        // Local energy detection. Audio is NEVER sent to OpenAI in this state.
        if (g711HasSpeech(audio)) {
          activeFrames++;
          if (activeFrames >= SPEECH_ON_FRAMES) {
            twilioState  = 'FORWARDING';
            activeFrames = 0;
            silentFrames = 0;
            blockedCount = 0;
            console.log(`[${clinicName}] twilio_user_activity_detected — forwarding audio to OpenAI`);
          }
        } else {
          activeFrames = 0;
          blockedCount++;
          if (blockedCount % 100 === 1) {
            console.log(`[${clinicName}] twilio_audio_blocked_waiting — ${blockedCount} frames suppressed`);
          }
        }
        return; // NEVER forward in WAITING
      }

      if (twilioState === 'FORWARDING') {
        sendToOpenAI({ type: 'input_audio_buffer.append', audio });

        if (g711HasSpeech(audio)) {
          silentFrames = 0;  // patient still speaking — reset silence counter
        } else {
          silentFrames++;
          if (silentFrames === SPEECH_OFF_FRAMES) {
            // 800 ms of silence after speech → commit buffer; wait for transcript
            twilioState  = 'COMMITTED';
            silentFrames = 0;
            sendToOpenAI({ type: 'input_audio_buffer.commit' });
            console.log(`[${clinicName}] twilio_buffer_committed — awaiting Whisper transcript`);
            guardTimer = setTimeout(() => {
              guardTimer = null;
              if (twilioState === 'COMMITTED') resetToWaiting('transcript timeout 8 s');
            }, COMMITTED_TIMEOUT);
          }
        }
      }
    }

    if (msg.event === 'stop') {
      console.log(`[Realtime:Twilio:${clinicName}] Twilio stream stopped  callSid=${callSid}`);
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on('close', () => {
    if (guardTimer) clearTimeout(guardTimer);
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
  let patientSpeaking   = false; // true while VAD reports active speech
  let patientSpoke      = false; // true after confirmed speech in this turn (gate for response)
  let speechStartTime   = null;  // timestamp of most recent speech_started
  let silenceTimer      = null;  // re-arms every 30 s to clear accumulated noise

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  function clearBuffer() {
    sendToOpenAI({ type: 'input_audio_buffer.clear' });
  }

  function armSilenceGuard() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (greetingDone && !patientSpeaking) {
        console.log(`[Realtime:Browser:${clinicName}] 30 s silence — clearing buffer`);
        clearBuffer();
        armSilenceGuard();
      }
    }, 30_000);
  }

  function disarmSilenceGuard() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  openaiWs.on('open', () => {
    console.log(`[Realtime:Browser] Connected to OpenAI for ${clinicName}`);
    sendToOpenAI({
      type: 'session.update',
      session: {
        modalities:   ['text', 'audio'],
        instructions,
        voice,
        // Browser uses PCM16 natively — keep defaults for audio format
        turn_detection: {
          type:                'server_vad',
          threshold:           0.6,
          prefix_padding_ms:   300,
          silence_duration_ms: 800,
        },
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

    if (evt.type === 'response.done') {
      if (greetingTriggered && !greetingDone) {
        greetingDone = true;
        clearBuffer();
        armSilenceGuard();
        console.log(`[Realtime:Browser:${clinicName}] Greeting done — buffer cleared, waiting for patient`);
      } else if (greetingDone && !patientSpeaking) {
        clearBuffer();
        armSilenceGuard();
      }
    }

    if (evt.type === 'input_audio_buffer.speech_started') {
      patientSpeaking = true;
      speechStartTime = Date.now();
      disarmSilenceGuard();
      console.log(`[Realtime:Browser:${clinicName}] Patient speech started`);
    }

    if (evt.type === 'input_audio_buffer.speech_stopped') {
      const duration = speechStartTime ? (Date.now() - speechStartTime) : 0;
      patientSpeaking = false;
      speechStartTime = null;
      if (duration >= 300) {
        patientSpoke = true;
        console.log(`[Realtime:Browser:${clinicName}] Patient speech confirmed (${duration} ms)`);
      } else {
        console.log(`[Realtime:Browser:${clinicName}] Noise suppressed (${duration} ms) — clearing buffer`);
        clearBuffer();
      }
    }

    if (evt.type === 'response.created' && greetingDone) {
      if (patientSpoke) {
        patientSpoke = false;
        console.log(`[Realtime:Browser:${clinicName}] Response allowed — patient spoke`);
      } else {
        console.log(`[Realtime:Browser:${clinicName}] Blocking auto-response — no patient speech detected`);
        sendToOpenAI({ type: 'response.cancel' });
        clearBuffer();
      }
    }

    if (evt.type === 'response.output_audio_transcript.done') {
      console.log(`[Realtime:Browser:${clinicName}] Ana: ${evt.transcript}`);
    }
    if (evt.type === 'error') {
      console.error(`[Realtime:Browser:${clinicName}] Error:`, evt.error?.message);
    }

    // Forward all OpenAI events to browser as UTF-8 text (not binary Blob)
    try { if (browserWs.readyState === WebSocket.OPEN) browserWs.send(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw); } catch {}
  });

  openaiWs.on('error', e => console.error(`[Realtime:Browser:${clinicName}] WS error:`, e.message));
  openaiWs.on('close', () => {
    disarmSilenceGuard();
    console.log(`[Realtime:Browser:${clinicName}] OpenAI closed`);
    try { browserWs.close(); } catch {}
  });

  browserWs.on('message', (raw, isBinary) => {
    try {
      const str = !isBinary && Buffer.isBuffer(raw) ? raw.toString('utf8') : (Buffer.isBuffer(raw) ? raw : raw);
      // Block input audio until Ana's greeting is complete
      if (!greetingDone && !isBinary) {
        const msg = JSON.parse(typeof str === 'string' ? str : str.toString('utf8'));
        if (msg.type === 'input_audio_buffer.append') return;
      }
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(str);
    } catch {}
  });
  browserWs.on('close', () => {
    disarmSilenceGuard();
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
