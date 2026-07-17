'use strict';
const express = require('express');
const router  = express.Router();

const {
  getClinicByTelnyxPhone,
  getKnowledgeBase,
  getBusinessRules,
  getTrainingFaqs,
} = require('../database/db');

const { createTelnyxRelay, getTelnyxRelay } = require('../services/realtime');

// ── POST /telnyx/webhook ──────────────────────────────────────────────────────
// Configured in Telnyx portal → Voice API Application → Webhook URL:
//   https://netcarephone.com/telnyx/webhook
//
// Clinic is identified by the destination number (E.164) in `payload.to`.
// All events for a call are routed to the relay registered in call.answered.

// Pending calls: callControlId → { clinic, callerPhone, apiKey }
// Populated in call.initiated, consumed in call.answered, cleaned on call.hangup
const _pendingCalls = new Map();

const TELNYX_API = 'https://api.telnyx.com/v2';

async function telnyxAction(callControlId, action, body, apiKey) {
  const r = await fetch(
    `${TELNYX_API}/calls/${encodeURIComponent(callControlId)}/actions/${action}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify(body),
    }
  );
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(`[Telnyx] ${action} failed: ${r.status} ${text}`);
  }
  return r;
}

router.post('/webhook', async (req, res) => {
  // Respond 200 immediately — Telnyx retries if it doesn't get a fast 2xx
  res.sendStatus(200);

  const event = req.body?.data;
  if (!event) return;

  const eventType     = event.event_type;
  const p             = event.payload || {};
  const callControlId = p.call_control_id;
  if (!callControlId) return;

  console.log(`[Telnyx] ${eventType}  ccid=…${callControlId.slice(-6)}`);

  try {

    // ── 1. call.initiated — validate, answer ─────────────────────────────────
    if (eventType === 'call.initiated' && p.direction === 'incoming') {
      const to   = p.to;
      const from = p.from || 'anonymous';

      if (!to) {
        console.warn('[Telnyx] call.initiated missing "to" field — ignoring');
        return;
      }

      const clinic = getClinicByTelnyxPhone(to);
      if (!clinic) {
        console.warn(`[Telnyx] No clinic configured for ${to} — hanging up`);
        const fallbackKey = process.env.TELNYX_API_KEY;
        if (fallbackKey) await telnyxAction(callControlId, 'hangup', {}, fallbackKey);
        return;
      }
      if (clinic.status === 'suspended' || clinic.status === 'cancelled') {
        console.warn(`[Telnyx/${clinic.slug}] Account ${clinic.status} — hanging up`);
        const key = clinic.telnyx_api_key || process.env.TELNYX_API_KEY;
        if (key) await telnyxAction(callControlId, 'hangup', {}, key);
        return;
      }

      const apiKey = clinic.telnyx_api_key || process.env.TELNYX_API_KEY;
      if (!apiKey) {
        console.error('[Telnyx] No API key configured — cannot answer call');
        return;
      }

      // Store context so call.answered can build the relay without re-querying
      _pendingCalls.set(callControlId, { clinic, callerPhone: from, apiKey });

      await telnyxAction(callControlId, 'answer', {}, apiKey);
      console.log(`[Telnyx/${clinic.slug}] Answered  from=${from}`);
      return;
    }

    // ── 2. call.answered — create relay, start transcription, send greeting ──
    if (eventType === 'call.answered') {
      const pending = _pendingCalls.get(callControlId);
      if (!pending) {
        console.warn(`[Telnyx] call.answered — no pending context for ccid=…${callControlId.slice(-6)}`);
        return;
      }
      const { clinic, callerPhone, apiKey } = pending;

      const kb = getKnowledgeBase(clinic.id) || {};
      kb.businessRules = getBusinessRules(clinic.id);
      kb.trainingFaqs  = getTrainingFaqs(clinic.id);

      // Create relay — registers itself in _telnyxRelays keyed by callControlId
      const relay = createTelnyxRelay(callControlId, callerPhone, clinic, kb, apiKey);

      // Start continuous inbound transcription (call.transcription events from here on)
      const txLang = clinic.ai_language === 'en' ? 'en' : 'es';
      const txR = await telnyxAction(callControlId, 'transcription_start', {
        transcription_engine: 'B',
        language:             txLang,
      }, apiKey);
      if (!txR.ok) {
        console.error(`[Telnyx/${clinic.slug}] transcription_start failed (${txR.status}) — cannot listen. Hanging up.`);
        relay.cleanup();
        await telnyxAction(callControlId, 'hangup', {}, apiKey);
        return;
      }
      console.log(`[Telnyx/${clinic.slug}] Transcription started  engine=B  lang=${txLang}`);

      // Play opening greeting (state: GREETING)
      await relay.onCallAnswered();
      return;
    }

    // ── Route remaining events to the active relay ────────────────────────────
    const relay = getTelnyxRelay(callControlId);

    // ── 5. call.transcription — final transcript → Claude → speak ────────────
    // Telnyx event: call.transcription (not call.transcription.ended)
    if (eventType === 'call.transcription') {
      const td      = p.transcription_data || {};
      const text    = (td.transcript || '').trim();
      const isFinal = td.is_final === true;
      console.log(`[Telnyx] call.transcription  is_final=${isFinal}  text="${text.slice(0, 80)}"  ccid=…${callControlId.slice(-6)}`);
      if (!isFinal || !text) return;
      if (!relay) {
        console.warn(`[Telnyx] No relay for transcription  ccid=…${callControlId.slice(-6)}`);
        return;
      }
      await relay.onTranscription(text);
      return;
    }

    // ── 6. call.speak.ended — Ana finished speaking → WAITING ────────────────
    if (eventType === 'call.speak.ended') {
      const eventCommandId = p.command_id || null;
      console.log(`[Telnyx] call.speak.ended  cmd=${eventCommandId ? eventCommandId.slice(0, 8) : 'n/a'}  ccid=…${callControlId.slice(-6)}`);
      if (relay) relay.onSpeakEnded(eventCommandId);
      return;
    }

    // ── 7. call.hangup — close call, save duration + transcript ──────────────
    if (eventType === 'call.hangup') {
      const reason    = p.hangup_cause  || p.hangup_reason || 'unknown';
      const causeCode = p.hangup_cause_code || '';
      const src       = p.hangup_source || '';
      console.log(`[Telnyx] call.hangup  ccid=${callControlId}  reason=${reason}  code=${causeCode}  src=${src}`);
      if (relay) relay.cleanup();
      _pendingCalls.delete(callControlId);
      return;
    }

  } catch (err) {
    console.error(`[Telnyx] webhook error (${eventType}):`, err.message);
  }
});

module.exports = router;
