const https     = require('https');
const WebSocket = require('ws');

const REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
const REALTIME_URL   = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

// ── System prompt for Realtime API ───────────────────────────────────────────

function buildRealtimeInstructions(clinic, kb) {
  const name     = clinic.name || 'the clinic';
  const asstName = clinic.ai_assistant_name || 'Ana';
  const lang     = clinic.openai_language || 'es';

  const lines = [
    `You are ${asstName}, an experienced, warm receptionist at ${name}.`,
    `You have worked at this office for many years. Callers feel comfortable and at ease talking to you.`,
    `You sound like a real person — never robotic, never rushed, never scripted.`,
    ``,
    lang === 'es'
      ? `Always respond in natural Latin American Spanish unless the caller clearly switches to English.\nUse these phrases naturally — not every turn:\n"Con mucho gusto.", "Claro, cómo no.", "Permítame un momento.", "No se preocupe, yo le ayudo.", "Perfecto, ya tengo esa información.", "Déjeme confirmar.", "Entendido.", "Muy bien.", "Claro que sí."`
      : `Always respond in clear, warm American English unless the caller speaks Spanish.\nUse these naturally: "Of course.", "Absolutely, I can help with that.", "Let me confirm that.", "Got it, thank you.", "No worries.", "You're all set."`,
    ``,
    `CONVERSATION STYLE:`,
    `- Short responses — 1 to 2 natural sentences on the phone`,
    `- Ask only one question per turn`,
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

  return lines.join('\n');
}

// ── Create ephemeral session token (for browser WebRTC) ──────────────────────

async function createEphemeralSession(apiKey, clinic, kb) {
  const instructions = buildRealtimeInstructions(clinic, kb);
  const voice        = clinic.openai_voice || 'shimmer';

  const body = JSON.stringify({
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
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/realtime/sessions',
      method:   'POST',
      headers: {
        Authorization:   `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error?.message || `OpenAI ${res.statusCode}`));
          else resolve(parsed);
        } catch { reject(new Error('Invalid JSON from OpenAI')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Twilio Media Streams → OpenAI Realtime relay (server-side WebSocket) ─────

function createTwilioRelay(twilioWs, apiKey, clinic, kb) {
  const instructions = buildRealtimeInstructions(clinic, kb);
  const voice        = clinic.openai_voice || 'shimmer';
  const clinicName   = clinic.name || 'the clinic';

  const openaiWs = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'OpenAI-Beta':  'realtime=v1',
    },
  });

  let streamSid    = null;
  let sessionReady = false;
  const pending    = [];

  function sendToOpenAI(obj) {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify(obj));
  }

  openaiWs.on('open', () => {
    console.log(`[Realtime] OpenAI WS connected for ${clinicName}`);
    // Configure session to use g711_ulaw — same as Twilio, zero transcoding
    sendToOpenAI({
      type: 'session.update',
      session: {
        voice,
        instructions,
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type:                'server_vad',
          threshold:           0.5,
          prefix_padding_ms:   300,
          silence_duration_ms: 700,
        },
        temperature: 0.8,
      },
    });
  });

  openaiWs.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }

    if (evt.type === 'session.created' || evt.type === 'session.updated') {
      sessionReady = true;
      while (pending.length) {
        sendToOpenAI({ type: 'input_audio_buffer.append', audio: pending.shift() });
      }
    }

    // Forward Ana's audio to Twilio
    if (evt.type === 'response.audio.delta' && evt.delta && streamSid) {
      try {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: evt.delta } }));
        }
      } catch { /* Twilio closed */ }
    }

    // Logging only
    if (evt.type === 'conversation.item.input_audio_transcription.completed') {
      console.log(`[Realtime:${clinicName}] Caller: ${evt.transcript}`);
    }
    if (evt.type === 'response.audio_transcript.done') {
      console.log(`[Realtime:${clinicName}] Ana: ${evt.transcript}`);
    }
    if (evt.type === 'error') {
      console.error(`[Realtime:${clinicName}] Error:`, evt.error?.message);
    }
  });

  openaiWs.on('error', e => console.error(`[Realtime:${clinicName}] WS error:`, e.message));
  openaiWs.on('close', () => { try { twilioWs.close(); } catch {} });

  // Receive audio and events from Twilio
  twilioWs.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || msg.streamSid;
      console.log(`[Realtime:${clinicName}] Twilio stream started: ${streamSid}`);
    }

    if (msg.event === 'media') {
      const audio = msg.media?.payload;
      if (!audio) return;
      if (sessionReady) {
        sendToOpenAI({ type: 'input_audio_buffer.append', audio });
      } else {
        pending.push(audio);
      }
    }

    if (msg.event === 'stop') {
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on('close', () => {
    console.log(`[Realtime:${clinicName}] Twilio stream closed`);
    try { openaiWs.close(); } catch {}
  });
  twilioWs.on('error', e => console.error(`[Realtime:${clinicName}] Twilio WS error:`, e.message));
}

module.exports = { buildRealtimeInstructions, createEphemeralSession, createTwilioRelay };
