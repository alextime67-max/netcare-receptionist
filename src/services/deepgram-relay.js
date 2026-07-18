'use strict';

// ── Deepgram Streaming STT Relay — Phase 2 ───────────────────────────────────
//
// WIRING STATUS: NOT CONNECTED TO LIVE CALLS YET (Phase 3 will wire this in).
// USE_STREAMING_STT=true has no effect until telnyx.js is updated in Phase 3.
//
// This module:
//   - Opens a Deepgram live-transcription WebSocket for each call
//   - Receives G.711 µ-law audio frames from a Telnyx media-streaming WebSocket
//   - Forwards audio to Deepgram and receives transcripts
//   - Calls relay.onTranscription(text, meta) — the same method the current
//     Telnyx STT path uses, so the rest of the stack is unchanged
//   - On Deepgram connection failure, calls relay.onSttFallback() so Phase 3
//     code can fall back to Telnyx transcription_start engine B

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

// Hardcoded medical/geographic terms always included in keyword boost
const BASE_KEYWORDS = [
  'MDcare', 'Medicare', 'Medicaid',
  'Hialeah', 'Homestead', 'Coral Gables', 'Miami',
  'BlueCross', 'Aetna', 'Humana', 'Cigna', 'United', 'Tricare', 'Molina',
  'Staywell', 'Simply Healthcare', 'AvMed', 'Devoted',
  'appointment', 'prescription', 'referral', 'specialist',
  'insurance', 'deductible', 'copay', 'prior authorization',
];

// Build keyword boost list from clinic config and KB
// Nova-2 format: ["term:boost"]  Nova-3 format: ["term"] (keytems, no boost value)
function buildKeywordList(clinic, kb) {
  const terms = new Set(BASE_KEYWORDS);

  // Doctor names from KB
  if (kb?.doctors) {
    const matches = kb.doctors.match(/Dr\.\s+\w+(?:\s+\w+)?/g) || [];
    matches.forEach(name => terms.add(name.replace(/^Dr\.\s+/, '')));
  }

  // Location names from KB
  if (kb?.locations) {
    const cityMatches = kb.locations.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}(?=,\s*FL)/g) || [];
    cityMatches.forEach(city => terms.add(city));
  }

  // Clinic-specific custom words (stored as JSON array in stt_custom_words)
  if (clinic.stt_custom_words) {
    try {
      const custom = JSON.parse(clinic.stt_custom_words);
      if (Array.isArray(custom)) custom.forEach(w => w?.trim() && terms.add(w.trim()));
    } catch {}
  }

  return Array.from(terms);
}

// Returns the Deepgram language param for the given stt_language_mode
function resolveLanguage(mode) {
  if (mode === 'es') return 'es';
  if (mode === 'en') return 'en-US';
  return 'multi'; // multilingual / auto-detect
}

// ── Main export ───────────────────────────────────────────────────────────────
//
// createDeepgramRelay(telnyxWs, relay, clinic, kb)
//
// telnyxWs — the WebSocket connection from Telnyx media streaming
//             (receives JSON frames: connected / start / media / stop)
// relay    — the createTelnyxRelay() instance for this call
//             (must expose: onTranscription(text, meta), onSttFallback?(provider))
// clinic   — clinic DB row (used for stt_model, stt_language_mode, stt_custom_words, name)
// kb       — knowledge base row + businessRules/trainingFaqs arrays (for keyword extraction)
//
// Returns { close() } for explicit cleanup, or null if DEEPGRAM_API_KEY is missing.

function createDeepgramRelay(telnyxWs, relay, clinic, kb) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    console.error('[Deepgram] DEEPGRAM_API_KEY not set — relay unavailable');
    return null;
  }

  const clinicName = clinic.name || 'unknown';
  const model      = clinic.stt_model || process.env.DEEPGRAM_MODEL || 'nova-3-medical';
  const langMode   = clinic.stt_language_mode || 'multilingual';
  const language   = resolveLanguage(langMode);
  const terms      = buildKeywordList(clinic, kb);

  // Nova-3 uses 'keyterm', Nova-2 uses 'keywords' with ":boost" suffix
  const isNova3    = model.startsWith('nova-3');
  const dgOptions  = {
    model,
    language,
    encoding:         'mulaw',
    sample_rate:      8000,
    channels:         1,
    smart_format:     true,
    no_delay:         true,
    endpointing:      800,      // ms of silence to trigger end-of-utterance
    utterance_end_ms: 1000,
    interim_results:  false,
  };
  if (isNova3) {
    dgOptions.keyterm = terms;
  } else {
    dgOptions.keywords = terms.map(t => `${t}:2`);
  }

  console.log(`[Deepgram/${clinicName}] opening — model=${model} lang=${language} terms=${terms.length} nova3=${isNova3}`);

  const deepgramClient = createClient(apiKey);
  let dgConn           = null;
  let dgOpen           = false;
  let fallbackDone     = false;
  let closed           = false;
  let turnIndex        = 0;
  const audioQueue     = []; // buffer audio until DG connection opens

  try {
    dgConn = deepgramClient.listen.live(dgOptions);
  } catch (err) {
    console.error(`[Deepgram/${clinicName}] createClient.listen.live failed:`, err.message);
    _fallback('create_failed');
    return null;
  }

  // Set a 5-second connection timeout — if Deepgram doesn't open, fall back
  const openTimeout = setTimeout(() => {
    if (!dgOpen) {
      console.warn(`[Deepgram/${clinicName}] connection timeout — activating fallback`);
      _fallback('connection_timeout');
    }
  }, 5000);

  dgConn.on(LiveTranscriptionEvents.Open, () => {
    clearTimeout(openTimeout);
    dgOpen = true;
    console.log(`[Deepgram/${clinicName}] connection OPEN  model=${model} lang=${language}`);
    // Drain buffered audio
    for (const chunk of audioQueue) {
      try { dgConn.send(chunk); } catch {}
    }
    audioQueue.length = 0;
  });

  dgConn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt) return;

    const text        = (alt.transcript || '').trim();
    const confidence  = typeof alt.confidence === 'number' ? alt.confidence : 1.0;
    const isFinal     = data.is_final === true;
    const speechFinal = data.speech_final === true;

    if (!text || (!isFinal && !speechFinal)) return;

    turnIndex++;
    const meta = {
      turnIndex,
      confidence,
      sttProvider:  'deepgram',
      sttModel:     model,
      fallbackUsed: false,
    };

    console.log(
      `[Deepgram/${clinicName}] transcript turn=${turnIndex}` +
      ` conf=${confidence.toFixed(2)} final=${isFinal} speech_final=${speechFinal}` +
      ` text="${text.slice(0, 80)}"`
    );
    console.log(`[TURN_LOG] ${JSON.stringify({ event: 'stt_transcript', clinic: clinicName, ...meta, text })}`);

    relay.onTranscription(text, meta);
  });

  dgConn.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
    console.log(`[Deepgram/${clinicName}] utterance_end last_word_end=${data?.last_word_end ?? 'n/a'}`);
  });

  dgConn.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[Deepgram/${clinicName}] error:`, err?.message || JSON.stringify(err));
    if (!fallbackDone) _fallback('deepgram_error');
  });

  dgConn.on(LiveTranscriptionEvents.Close, (event) => {
    dgOpen = false;
    const code   = event?.code ?? 'n/a';
    const reason = event?.reason || '—';
    console.log(`[Deepgram/${clinicName}] connection CLOSED code=${code} reason=${reason}`);
    if (!fallbackDone && !closed) _fallback('deepgram_closed');
  });

  // ── Telnyx media-stream WebSocket message handler ─────────────────────────
  //
  // Telnyx sends JSON frames over this WebSocket:
  //   { event: "connected", ... }
  //   { event: "start",  start:  { call_control_id, stream_sid, ... } }
  //   { event: "media",  media:  { track, payload: base64(G711µlaw) } }
  //   { event: "stop",   stop:   { stream_sid } }

  telnyxWs.on('message', (raw) => {
    if (closed) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'connected':
        console.log(`[Deepgram/${clinicName}] Telnyx stream connected`);
        break;

      case 'start': {
        const ccid = msg.start?.call_control_id;
        const sid  = msg.start?.stream_sid;
        console.log(`[Deepgram/${clinicName}] Telnyx stream START  ccid=…${ccid?.slice(-6) || 'n/a'}  sid=…${sid?.slice(-6) || 'n/a'}`);
        break;
      }

      case 'media': {
        const payload = msg.media?.payload;
        if (!payload) break;
        const chunk = Buffer.from(payload, 'base64');
        if (dgOpen) {
          try { dgConn.send(chunk); } catch (e) {
            console.error(`[Deepgram/${clinicName}] send error:`, e.message);
          }
        } else {
          audioQueue.push(chunk);
          // Cap queue at ~5 seconds of audio (8000 samples/s × ~160 bytes/frame × ~250 frames)
          if (audioQueue.length > 250) audioQueue.shift();
        }
        break;
      }

      case 'stop':
        console.log(`[Deepgram/${clinicName}] Telnyx stream STOP`);
        _close();
        break;
    }
  });

  telnyxWs.on('close', () => {
    console.log(`[Deepgram/${clinicName}] Telnyx WS closed`);
    _close();
  });

  telnyxWs.on('error', (err) => {
    console.error(`[Deepgram/${clinicName}] Telnyx WS error:`, err.message);
    _close();
  });

  function _close() {
    if (closed) return;
    closed = true;
    audioQueue.length = 0;
    if (dgConn && dgOpen) {
      try { dgConn.requestClose(); } catch {}
      dgOpen = false;
    }
  }

  // Called when Deepgram is unavailable — signals relay to activate Telnyx STT fallback
  function _fallback(reason) {
    if (fallbackDone) return;
    fallbackDone = true;
    const provider = process.env.STT_FALLBACK_PROVIDER || 'telnyx';
    console.warn(`[Deepgram/${clinicName}] fallback → ${provider}  reason=${reason}`);
    console.log(`[TURN_LOG] ${JSON.stringify({ event: 'stt_fallback', clinic: clinicName, reason, provider })}`);
    if (typeof relay.onSttFallback === 'function') relay.onSttFallback(provider);
  }

  return { close: _close };
}

module.exports = { createDeepgramRelay, buildKeywordList, resolveLanguage };
