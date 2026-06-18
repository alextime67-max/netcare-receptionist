const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory sessions keyed by Twilio CallSid
const sessions = new Map();

const SYSTEM_PROMPT = `You are the AI receptionist for NetCare medical clinic. You handle inbound phone calls.

════════════════════════════════════════
MISSION: Collect patient information and route their request.
════════════════════════════════════════

INFORMATION TO COLLECT (in this order):
1. Detect language preference from first patient response
2. Patient full name (confirm spelling)
3. Best callback phone number
4. Request type: APPOINTMENT or DOCTOR MESSAGE
5. For APPOINTMENT → preferred date, preferred time, brief reason
6. For MESSAGE → message content, urgency (routine or urgent)

════════════════════════════════════════
OUTPUT FORMAT — ALWAYS return raw JSON only (no markdown fences, no extra text):
════════════════════════════════════════
{
  "speak": "What to say aloud — max 35 words, warm and conversational",
  "language": "en",
  "intent": "greeting|collecting|confirming|end",
  "collected": {
    "name": null,
    "phone": null,
    "callType": null,
    "reason": null,
    "appointmentDate": null,
    "appointmentTime": null,
    "messageContent": null,
    "urgency": null
  },
  "complete": false,
  "emergencyDetected": false
}

════════════════════════════════════════
RULES (follow exactly):
════════════════════════════════════════
1. EMERGENCY PRIORITY: If patient mentions chest pain, difficulty breathing, severe bleeding,
   loss of consciousness, stroke symptoms, overdose, or any life-threatening emergency →
   set emergencyDetected:true, complete:true, speak:"This is a medical emergency. Please hang up and call 9-1-1 immediately."

2. BREVITY: Keep every spoken response under 35 words. Phone callers hate long messages.

3. ONE QUESTION PER TURN: Never ask two things at once.

4. LANGUAGE DETECTION: If patient speaks Spanish or says "español/espanol" → switch entirely
   to Spanish for ALL remaining responses. Maintain chosen language throughout.

5. NAME CONFIRMATION: After getting a name, spell it back: "I have Maria Garcia — is that right?"

6. PHONE CONFIRMATION: After getting a phone number, read it back digit by digit.

7. COMPLETION: When you have all required fields for the request type, set complete:true and
   give a warm closing: confirm what was collected and say goodbye.

8. NEVER give medical advice. Never share other patients' info. Always be HIPAA-conscious.

9. COLLECTED FIELD: Always return the FULL collected object, carrying forward all previously
   gathered data. Only update fields you collected in THIS turn.

════════════════════════════════════════
EXAMPLE — English appointment flow:
════════════════════════════════════════
Turn 1 assistant: {"speak":"Thank you for calling NetCare! Para español, diga español. How can I help you today?","language":"en","intent":"greeting","collected":{...nulls},"complete":false}
Patient: "I need to make an appointment"
Turn 2 assistant: {"speak":"I'd be happy to help schedule that. May I have your full name please?","language":"en","intent":"collecting","collected":{"callType":"appointment",...},"complete":false}
...continue collecting until all appointment fields are gathered, then complete:true...

EXAMPLE — Spanish message flow:
Patient says: "necesito dejar un mensaje"
assistant: {"speak":"Con gusto le ayudo. ¿Podría decirme su nombre completo?","language":"es","intent":"collecting","collected":{"callType":"message",...},"complete":false}`;

// ── Session management ────────────────────────────────────────────────────────

function initSession(callSid, callerPhone) {
  sessions.set(callSid, {
    messages:  [],
    collected: {
      name: null, phone: callerPhone || null, callType: null,
      reason: null, appointmentDate: null, appointmentTime: null,
      messageContent: null, urgency: null,
    },
    language:  'en',
    dbId:      null,
    turnCount: 0,
  });
}

function getSession(callSid) {
  return sessions.get(callSid);
}

function setSessionDbId(callSid, dbId) {
  const s = sessions.get(callSid);
  if (s) s.dbId = dbId;
}

function endSession(callSid) {
  const s = sessions.get(callSid);
  sessions.delete(callSid);
  return s;
}

// ── AI processing ─────────────────────────────────────────────────────────────

async function processMessage(callSid, patientSpeech) {
  const session = sessions.get(callSid);
  if (!session) throw new Error(`No active session for ${callSid}`);

  session.messages.push({ role: 'user', content: patientSpeech });
  session.turnCount++;

  // Safety ceiling — prevent runaway conversations
  if (session.turnCount > 25) {
    const fallback = session.language === 'es'
      ? 'Gracias por llamar a NetCare. Un representante le contactará pronto. Que tenga buen día.'
      : 'Thank you for calling NetCare. A staff member will follow up with you soon. Goodbye!';
    return { speak: fallback, language: session.language, complete: true, emergencyDetected: false, collected: session.collected };
  }

  try {
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      system:     SYSTEM_PROMPT,
      messages:   session.messages,
    });

    const rawText = response.content[0].text.trim();
    let parsed;

    try {
      // Strip any accidental markdown fences
      const jsonStr = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      parsed = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? jsonStr);
    } catch {
      // Graceful degradation — treat raw text as spoken response
      parsed = {
        speak:             rawText.substring(0, 200),
        language:          session.language,
        intent:            'collecting',
        collected:         {},
        complete:          false,
        emergencyDetected: false,
      };
    }

    // Merge collected fields (only update non-null new values)
    if (parsed.collected) {
      for (const [k, v] of Object.entries(parsed.collected)) {
        if (v !== null && v !== undefined && v !== '') {
          session.collected[k] = v;
        }
      }
    }

    if (parsed.language) session.language = parsed.language;
    session.messages.push({ role: 'assistant', content: rawText });

    return {
      speak:             parsed.speak || getErrorMessage(session.language),
      language:          session.language,
      complete:          parsed.complete || false,
      emergencyDetected: parsed.emergencyDetected || false,
      intent:            parsed.intent || 'collecting',
      collected:         { ...session.collected },
    };
  } catch (error) {
    console.error('[AI] Processing error:', error.message);
    const msg = getErrorMessage(session.language);
    session.messages.push({ role: 'assistant', content: msg });
    return { speak: msg, language: session.language, complete: false, emergencyDetected: false, collected: { ...session.collected } };
  }
}

// ── Canned strings ────────────────────────────────────────────────────────────

function getInitialGreeting() {
  return 'Thank you for calling NetCare! Para español, diga español. How can I help you today?';
}

function getErrorMessage(lang) {
  return lang === 'es'
    ? 'Lo siento, tuve un problema técnico. ¿Podría repetir eso por favor?'
    : "I'm sorry, I had a technical issue. Could you please repeat that?";
}

function getNoInputMessage(lang) {
  return lang === 'es'
    ? 'No escuché nada. ¿Podría repetir por favor?'
    : "I didn't catch that. Could you please say that again?";
}

function getTimeoutGoodbye(lang) {
  return lang === 'es'
    ? 'No recibimos respuesta. Gracias por llamar a NetCare. ¡Hasta luego!'
    : "We didn't receive a response. Thank you for calling NetCare. Goodbye!";
}

module.exports = {
  initSession,
  getSession,
  setSessionDbId,
  endSession,
  processMessage,
  getInitialGreeting,
  getErrorMessage,
  getNoInputMessage,
  getTimeoutGoodbye,
};
