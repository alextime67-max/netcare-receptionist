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

  console.log(`[Telnyx] ${eventType}  ccid=${callControlId}  from=${from}  to=${to}`);

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
});

module.exports = router;
