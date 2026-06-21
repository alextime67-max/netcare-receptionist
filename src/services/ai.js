const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory sessions keyed by Twilio CallSid
const sessions = new Map();

// ── Industry templates ────────────────────────────────────────────────────────

const INDUSTRY_TEMPLATES = {
  medical: {
    label:       'Medical Clinic',
    description: 'HIPAA-conscious. Routes appointments, prescription refill requests, and doctor messages. Never gives medical advice.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, a medical clinic. You handle inbound patient calls professionally, warmly, and with full HIPAA awareness.',
    tone:        'Warm, reassuring, and professional. Patients may be anxious or unwell — be patient and empathetic.',
    intentExamples: [
      'Appointment scheduling (new patient or follow-up)',
      'Prescription refill request — collect name, DOB, medication name, pharmacy; do NOT process',
      'Test results inquiry — never discuss results; take name & callback, flag for nurse',
      'Referral request — collect name and referring doctor if known',
      'Billing question — collect name & callback; route to billing department',
    ],
    extraRules: [
      'NEVER give medical advice, diagnoses, or discuss test results.',
      'For prescription refills: collect patient name, date of birth, medication name, and pharmacy. Inform them a staff member will follow up.',
      'For test result calls: do not confirm or deny any result. Take name and callback number only.',
      'HIPAA: never confirm whether someone is a patient or share any patient information with others.',
    ],
  },
  dental: {
    label:       'Dental Office',
    description: 'Friendly tone with dental emergency triage. Routes cleanings, cosmetic consults, and urgent dental pain differently.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, a dental office. You schedule appointments, triage dental emergencies, and assist patients warmly.',
    tone:        'Friendly and reassuring. Many callers have dental anxiety — be especially calm and welcoming.',
    intentExamples: [
      'Routine cleaning or checkup',
      'Dental emergency (severe pain, broken tooth, lost filling, swelling)',
      'Cosmetic consultation (whitening, veneers, Invisalign)',
      'New patient appointment',
      'Billing or insurance question',
    ],
    extraRules: [
      'For dental emergencies (severe pain, broken tooth, facial swelling): treat as priority — ask if they need a same-day urgent appointment.',
      'For routine cleanings: ask when their last visit was and if they have dental insurance.',
      'Inform new patients their first appointment is typically 60 minutes (vs 45 minutes for existing patients).',
      'Never give treatment recommendations or diagnoses over the phone.',
    ],
  },
  tax: {
    label:       'Tax Office',
    description: 'Professional tone for tax prep and accounting. Routes appointment requests, IRS notice help, and general tax inquiries.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, a tax preparation and accounting firm. You schedule appointments and route client inquiries.',
    tone:        'Professional, efficient, and reassuring. Clients calling about tax issues are often stressed — be calm and helpful.',
    intentExamples: [
      'Tax preparation appointment (personal or business)',
      'IRS notice or audit assistance',
      'Extension filing question',
      'Business accounting or bookkeeping services',
      'Existing client follow-up',
    ],
    extraRules: [
      'Never give specific tax advice. Collect name, phone, and the general nature of the question — a tax professional will call back.',
      'Tax season (January–April): set expectations that appointment slots fill quickly.',
      'For IRS notices: ask for the notice CP number or letter type and the date — collect and flag for callback.',
    ],
  },
  law: {
    label:       'Law Firm',
    description: 'Formal tone. Collects new-client intake without discussing case details. Flags urgent matters. Never gives legal advice.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, a law firm. You handle new-client intake and route existing-client calls professionally.',
    tone:        'Formal and professional. Legal matters are sensitive — be careful, thorough, and never give legal opinions.',
    intentExamples: [
      'New client consultation request',
      'Existing client follow-up',
      'Urgent legal matter (arrest, imminent court date, restraining order)',
      'General legal inquiry',
    ],
    extraRules: [
      'NEVER give legal advice of any kind — not even general guidance.',
      'For new clients: collect name, phone, and practice area interest (family law, criminal, personal injury, etc.). Do NOT ask for detailed case facts.',
      'For urgent matters (arrest, court tomorrow, active custody dispute): flag as URGENT, collect name & phone immediately, and promise same-business-day callback.',
      'Attorney-client privilege: do not discuss or reference any existing case details on an AI line.',
    ],
  },
  insurance: {
    label:       'Insurance Agency',
    description: 'Professional tone for policy questions, claims, and new quotes. Collects policy numbers and routes to agents.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, an insurance agency. You route policy and claims inquiries and collect client information.',
    tone:        'Professional, calm, and empathetic. Callers about claims may be distressed — acknowledge their situation before collecting details.',
    intentExamples: [
      'New insurance quote (auto, home, life, commercial)',
      'Existing policy question',
      'Claim filing',
      'Billing or payment issue',
      'Policy cancellation or change',
    ],
    extraRules: [
      'For claim calls: express empathy first, then collect name, policy number, date of incident, and a brief description.',
      'For payment issues: collect name, policy number, and best callback time.',
      'Never confirm or discuss coverage details — collect information and route to an agent.',
      'For cancellation requests: take name, policy number, and reason, then route to retention team.',
    ],
  },
  realestate: {
    label:       'Real Estate Office',
    description: 'Enthusiastic, sales-oriented tone. Routes buyers, sellers, and renters. Collects budget, area, and timeline.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, a real estate agency. You assist buyers, sellers, and renters with their property needs.',
    tone:        'Warm, enthusiastic, and professional. Real estate is exciting — share that energy while gathering key details.',
    intentExamples: [
      'Buyer inquiry (area, budget, home type)',
      'Seller listing inquiry',
      'Rental inquiry',
      'Property showing request',
      'General market or neighborhood question',
    ],
    extraRules: [
      'For buyers: collect budget range, desired area or zip code, number of bedrooms/bathrooms, and purchase timeline.',
      'For sellers: collect approximate property address, timeline to sell, and whether they already have an agent.',
      'For showings: collect the property address of interest, preferred date/time, and contact info.',
      'For rental inquiries: collect move-in date, monthly budget, bedroom count, and area preference.',
    ],
  },
  itsupport: {
    label:       'IT Support / MSP',
    description: 'Efficient, technical tone. Triages by severity. Flags server outages and ransomware for immediate escalation.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}, an IT support and managed services company. You triage support requests and route them efficiently.',
    tone:        'Efficient and calm. Callers with IT issues are often frustrated — be solution-focused and reassuring.',
    intentExamples: [
      'New support ticket (software, hardware, connectivity)',
      'P1 emergency (server down, network outage, ransomware)',
      'Existing ticket follow-up',
      'New managed services inquiry',
      'Billing question',
    ],
    extraRules: [
      'For P1 emergencies (server down, full network outage, ransomware): collect name, company, and phone immediately — promise immediate technician callback. Flag as URGENT.',
      'For standard tickets: collect name, company, system/device affected, brief description, and severity (can work around it vs. completely blocked).',
      'For ticket follow-ups: collect name, company, and ticket number if available.',
      'For new MSP inquiries: collect company name, user/device count, and current IT challenges — route to a sales engineer.',
    ],
  },
  restaurant: {
    label:       'Restaurant',
    description: 'Warm host tone for reservations and event inquiries. Does not take food orders. Routes large-party requests to a manager.',
    persona:     'You are {assistantName}, the friendly AI host for {clinicName}. You handle reservations, event inquiries, and general questions about the restaurant.',
    tone:        'Warm, welcoming, and enthusiastic about the dining experience.',
    intentExamples: [
      'Reservation request',
      'Large party or private event inquiry (8+ guests)',
      'Hours, location, or parking question',
      'Menu or dietary accommodation question',
      'To-go / delivery order (redirect to online system)',
    ],
    extraRules: [
      'For reservations: collect guest name, party size, preferred date and time, and any special occasions or dietary needs.',
      'For large parties (8+ guests) or private events: take contact info and advise a manager will call back to discuss deposit and details.',
      'Do NOT take food orders over this line — direct callers to the website or delivery apps.',
      'For menu or allergen questions: give general guidance and invite them to visit the website or ask on arrival.',
    ],
  },
  general: {
    label:       'General Business',
    description: 'Neutral, professional tone. Collects name, contact, and nature of inquiry. Routes to the appropriate department or takes a message.',
    persona:     'You are {assistantName}, the AI receptionist for {clinicName}. You professionally handle inbound inquiries and connect callers with the right person.',
    tone:        'Professional, helpful, and neutral.',
    intentExamples: [
      'General inquiry',
      'Appointment or meeting request',
      'Request to speak with a specific staff member',
      'Directions, hours, or location question',
    ],
    extraRules: [
      'Collect caller name, best callback phone number, and the nature of their inquiry before routing.',
      'If the caller needs a specific staff member, collect both their name and the staff member requested.',
    ],
  },
};

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(clinic) {
  const clinicName    = typeof clinic === 'string' ? clinic : (clinic.name || 'NetCare Clinic');
  const cfg           = typeof clinic === 'object' ? clinic : {};
  const assistantName = cfg.ai_assistant_name || 'AI Receptionist';

  // Industry template
  const tmplKey = cfg.ai_industry_template || '';
  const tmpl    = tmplKey && INDUSTRY_TEMPLATES[tmplKey] ? INDUSTRY_TEMPLATES[tmplKey] : null;

  // Persona opening line
  const personaLine = tmpl
    ? tmpl.persona.replace('{assistantName}', assistantName).replace('{clinicName}', clinicName)
    : `You are ${assistantName}, the AI receptionist for ${clinicName}. You handle inbound phone calls.`;

  // Build clinic-specific context sections
  const sections = [];

  if (tmpl && tmpl.tone)
    sections.push(`TONE & STYLE:\n${tmpl.tone}`);

  if (tmpl && tmpl.intentExamples && tmpl.intentExamples.length)
    sections.push(`COMMON CALL TYPES FOR THIS BUSINESS:\n${tmpl.intentExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);

  if (cfg.ai_business_description)
    sections.push(`ABOUT THIS BUSINESS:\n${cfg.ai_business_description}`);

  if (cfg.ai_services)
    sections.push(`SERVICES OFFERED:\n${cfg.ai_services}`);

  if (cfg.ai_office_hours)
    sections.push(`OFFICE HOURS:\n${cfg.ai_office_hours}`);

  if (cfg.ai_appointment_instructions)
    sections.push(`APPOINTMENT SCHEDULING INSTRUCTIONS:\n${cfg.ai_appointment_instructions}`);

  if (cfg.ai_transfer_rules)
    sections.push(`CALL TRANSFER / ROUTING RULES:\n${cfg.ai_transfer_rules}`);

  if (cfg.ai_after_hours_message)
    sections.push(`AFTER HOURS POLICY:\n${cfg.ai_after_hours_message}`);

  if (cfg.ai_emergency_instructions)
    sections.push(`EMERGENCY PROTOCOL (overrides default below if set):\n${cfg.ai_emergency_instructions}`);

  if (cfg.ai_faq) {
    try {
      const faqs = JSON.parse(cfg.ai_faq);
      if (Array.isArray(faqs) && faqs.length) {
        const faqText = faqs
          .filter(f => f.q && f.a)
          .map(f => `Q: ${f.q}\nA: ${f.a}`)
          .join('\n\n');
        if (faqText)
          sections.push(`FREQUENTLY ASKED QUESTIONS — answer these accurately when asked:\n${faqText}`);
      }
    } catch { /* ignore bad JSON */ }
  }

  // Industry-specific extra rules from template (appended after business config)
  if (tmpl && tmpl.extraRules && tmpl.extraRules.length)
    sections.push(`INDUSTRY-SPECIFIC RULES:\n${tmpl.extraRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`);

  // Master prompt — highest priority, appended last, can override anything above
  if (cfg.ai_master_prompt && cfg.ai_master_prompt.trim())
    sections.push(`CUSTOM MASTER INSTRUCTIONS (HIGHEST PRIORITY — these override any conflicting rule):\n${cfg.ai_master_prompt.trim()}`);

  const contextBlock = sections.length
    ? `\n════════════════════════════════════════\nBUSINESS CONTEXT:\n════════════════════════════════════════\n${sections.join('\n\n')}\n`
    : '';

  return `${personaLine}
${contextBlock}
════════════════════════════════════════
MISSION: Collect caller information and route their request.
════════════════════════════════════════

INFORMATION TO COLLECT (in this order):
1. Detect language preference from first caller response
2. Caller full name (confirm spelling)
3. Best callback phone number
4. Request type: APPOINTMENT or MESSAGE
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
  "emergencyDetected": false,
  "transfer": false
}

════════════════════════════════════════
RULES (follow exactly):
════════════════════════════════════════
1. EMERGENCY PRIORITY: If caller mentions chest pain, difficulty breathing, severe bleeding,
   loss of consciousness, stroke symptoms, overdose, or any life-threatening emergency →
   set emergencyDetected:true, complete:true, speak:"This is a medical emergency. Please hang up and call 9-1-1 immediately."

2. BREVITY: Keep every spoken response under 35 words. Phone callers hate long messages.

3. ONE QUESTION PER TURN: Never ask two things at once.

4. LANGUAGE DETECTION: If caller speaks Spanish or says "español/espanol" → switch entirely
   to Spanish for ALL remaining responses. Maintain chosen language throughout.

5. NAME CONFIRMATION: After getting a name, spell it back: "I have Maria Garcia — is that right?"

6. PHONE CONFIRMATION: After getting a phone number, read it back digit by digit.

7. COMPLETION: When all required fields for the request type are collected, set complete:true
   and give a warm closing: confirm what was collected and say goodbye.

8. PROFESSIONALISM: Never give medical/legal/financial advice. Never share other clients' info.

9. COLLECTED FIELD: Always return the FULL collected object, carrying forward all previously
   gathered data. Only update fields collected in THIS turn.

10. CALL TRANSFER: If the caller explicitly asks to speak with a human, live agent, receptionist,
    nurse, doctor, or attorney — OR if the CALL TRANSFER / ROUTING RULES above specify a
    transfer condition is met — set transfer:true, complete:true, intent:"transfer", and
    speak:"Please hold while I transfer your call." (Spanish: "Por favor espere, le voy a transferir.")
    ONLY set transfer:true when clearly warranted. Most calls complete without transfer.

════════════════════════════════════════
EXAMPLE — English appointment flow:
════════════════════════════════════════
Turn 1 assistant: {"speak":"Thank you for calling ${clinicName}! Para español, diga español. How can I help you today?","language":"en","intent":"greeting","collected":{...nulls},"complete":false}
Patient: "I need to make an appointment"
Turn 2 assistant: {"speak":"I'd be happy to help schedule that. May I have your full name please?","language":"en","intent":"collecting","collected":{"callType":"appointment",...},"complete":false}
...continue collecting until all fields gathered, then complete:true...

EXAMPLE — Spanish message flow:
Caller says: "necesito dejar un mensaje"
assistant: {"speak":"Con gusto le ayudo. ¿Podría decirme su nombre completo?","language":"es","intent":"collecting","collected":{"callType":"message",...},"complete":false}`;
}

// ── Session management ────────────────────────────────────────────────────────

// ── Knowledge-base prompt builder ─────────────────────────────────────────────

function buildKbPromptSection(kb, selectedCenter) {
  if (!kb) return '';
  const centerNote = selectedCenter
    ? `\nThe patient selected the ${selectedCenter.label} location. Prioritize information for that location.`
    : '';
  const body = [
    kb.services                 && `### Services Offered\n${kb.services}`,
    kb.doctors                  && `### Doctors / Providers\n${kb.doctors}`,
    kb.locations                && `### Locations\n${kb.locations}`,
    kb.office_hours             && `### Office Hours\n${kb.office_hours}`,
    kb.insurance                && `### Insurance Accepted\n${kb.insurance}`,
    kb.appointment_policy       && `### Appointment Policy\n${kb.appointment_policy}`,
    kb.cancellation_policy      && `### Cancellation Policy\n${kb.cancellation_policy}`,
    kb.new_patient_requirements && `### New Patient Requirements\n${kb.new_patient_requirements}`,
    kb.documents_needed         && `### Documents Needed\n${kb.documents_needed}`,
    kb.faqs                     && `### Frequently Asked Questions\n${kb.faqs}`,
    kb.transfer_rules           && `### Transfer Rules\n${kb.transfer_rules}`,
    kb.emergency_instructions   && `### Emergency Instructions\n${kb.emergency_instructions}`,
  ].filter(Boolean).join('\n\n');

  const doNotAnswer = kb.do_not_answer
    ? `\n\n### Topics You Must NOT Answer\n${kb.do_not_answer}`
    : '';

  return `

════════════════════════════════════════
KNOWLEDGE BASE — APPROVED INFORMATION ONLY${centerNote}
════════════════════════════════════════
Answer patient questions ONLY using content below. If a question is not covered here, respond:
"I do not have that information available, but I can take a message and have the clinic contact you."
and set "unanswered": true in your JSON.

MEDICAL SAFETY — ABSOLUTE RULE: Never give medical advice, diagnosis, or treatment recommendations. For emergencies always say: "If this is a medical emergency, please call 911 or go to the nearest emergency room immediately." and set "emergencyDetected": true.

${body}${doNotAnswer}

JSON reminder: include "unanswered": false normally, or "unanswered": true when using the fallback answer.`;
}

// ── Session management ────────────────────────────────────────────────────────

function initSession(callSid, callerPhone, clinic, kb = null) {
  const clinicName = typeof clinic === 'string' ? clinic : (clinic.name || 'NetCare Clinic');
  sessions.set(callSid, {
    messages:  [],
    collected: {
      name: null, phone: callerPhone || null, callType: null,
      reason: null, appointmentDate: null, appointmentTime: null,
      messageContent: null, urgency: null,
    },
    language:  'es',
    clinic:    typeof clinic === 'object' ? clinic : { name: clinicName },
    clinicName,
    dbId:             null,
    turnCount:        0,
    selectedCenter:   null,
    ivrTimeouts:      0,
    kb:               kb || null,
    cachedSystemPrompt: null, // built once on first AI turn
  });
}

function getSession(callSid)        { return sessions.get(callSid); }
function setSessionDbId(callSid, id){ const s = sessions.get(callSid); if (s) s.dbId = id; }
function endSession(callSid)        { const s = sessions.get(callSid); sessions.delete(callSid); return s; }

function setSelectedCenter(callSid, center) {
  const s = sessions.get(callSid);
  if (s) s.selectedCenter = center;
}

function setSessionLanguage(callSid, lang) {
  const s = sessions.get(callSid);
  if (s) s.language = lang;
}

function incrementIvrTimeouts(callSid) {
  const s = sessions.get(callSid);
  if (!s) return 1;
  s.ivrTimeouts = (s.ivrTimeouts || 0) + 1;
  return s.ivrTimeouts;
}

// ── AI processing (live calls) ────────────────────────────────────────────────

async function processMessage(callSid, patientSpeech) {
  const session = sessions.get(callSid);
  if (!session) throw new Error(`No active session for ${callSid}`);

  session.messages.push({ role: 'user', content: patientSpeech });
  session.turnCount++;

  if (session.turnCount > 25) {
    const fallback = session.language === 'es'
      ? `Gracias por llamar a ${session.clinicName}. Un representante le contactará pronto. Que tenga buen día.`
      : `Thank you for calling ${session.clinicName}. A staff member will follow up with you soon. Goodbye!`;
    return { speak: fallback, language: session.language, complete: true, emergencyDetected: false, collected: session.collected };
  }

  try {
    // Build system prompt once per call; cache it in the session
    if (!session.cachedSystemPrompt) {
      let sp = buildSystemPrompt(session.clinic);
      if (session.selectedCenter && !session.kb) {
        sp += `\n\n## Selected Location\nThe patient selected the ${session.selectedCenter.label}. Direct all scheduling, messages, transfers, and voicemail to this location.`;
      }
      if (session.kb) {
        sp += buildKbPromptSection(session.kb, session.selectedCenter);
      }
      session.cachedSystemPrompt = sp;
    }

    const aiT0 = Date.now();
    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 300,
      system:     session.cachedSystemPrompt,
      messages:   session.messages,
    });
    console.log(`[AI] turn=${session.turnCount} latency=${Date.now() - aiT0}ms out_tokens=${response.usage?.output_tokens ?? '?'} CallSid=${callSid}`);

    const rawText = response.content[0].text.trim();
    let parsed;

    try {
      const jsonStr = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      parsed = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? jsonStr);
    } catch {
      parsed = {
        speak: rawText.substring(0, 200), language: session.language,
        intent: 'collecting', collected: {}, complete: false, emergencyDetected: false,
      };
    }

    if (parsed.collected) {
      for (const [k, v] of Object.entries(parsed.collected)) {
        if (v !== null && v !== undefined && v !== '') session.collected[k] = v;
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
      unanswered:        parsed.unanswered || false,
      transfer:          parsed.transfer   || false,
      collected:         { ...session.collected },
    };
  } catch (error) {
    console.error('[AI] Processing error:', error.message);
    const msg = getErrorMessage(session.language);
    session.messages.push({ role: 'assistant', content: msg });
    return { speak: msg, language: session.language, complete: false, emergencyDetected: false, collected: { ...session.collected } };
  }
}

// ── AI test simulator (stateless, no sessions) ────────────────────────────────

async function runTestMessage(clinic, conversationMessages, userMessage) {
  const messages = [
    ...conversationMessages,
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 600,
    system:     buildSystemPrompt(clinic),
    messages,
  });

  const rawText = response.content[0].text.trim();
  let parsed;

  try {
    const jsonStr = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? jsonStr);
  } catch {
    parsed = {
      speak: rawText.substring(0, 200), language: 'en',
      intent: 'collecting', collected: {}, complete: false, emergencyDetected: false,
    };
  }

  return {
    speak:             parsed.speak || 'I had a technical issue.',
    language:          parsed.language || 'en',
    complete:          parsed.complete || false,
    emergencyDetected: parsed.emergencyDetected || false,
    intent:            parsed.intent || 'collecting',
    collected:         parsed.collected || {},
    rawJson:           parsed,
    updatedMessages:   [...messages, { role: 'assistant', content: rawText }],
  };
}

// ── Canned strings ────────────────────────────────────────────────────────────

function getInitialGreeting(clinic) {
  const name = typeof clinic === 'string' ? clinic : (clinic.name || 'NetCare');
  const cfg  = typeof clinic === 'object' ? clinic : {};
  if (cfg.ai_greeting_es) return cfg.ai_greeting_es;
  if (cfg.ai_greeting_en) return cfg.ai_greeting_en;
  return `Gracias por llamar a ${name}. ¿Cómo puedo ayudarle hoy?`;
}

function getSpanishGreeting(clinic) {
  const cfg = typeof clinic === 'object' ? clinic : {};
  if (cfg.ai_greeting_es) return cfg.ai_greeting_es;
  return null; // fall back to regular greeting detection
}

function getErrorMessage(lang) {
  return lang === 'es'
    ? 'Lo siento, tuve un problema técnico. ¿Podría repetir eso por favor?'
    : "I'm sorry, I had a technical issue. Could you please repeat that?";
}

function getNoInputMessage(lang) {
  return lang === 'es'
    ? 'No hemos recibido respuesta. ¿Podría repetir por favor?'
    : "I didn't catch that. Could you please say that again?";
}

function getTimeoutGoodbye(lang, clinicName) {
  const name = clinicName ? ` a ${clinicName}` : '';
  return lang === 'es'
    ? `Gracias por llamar${name}. Que tenga un excelente día.`
    : `Thank you for calling${name}. Have a great day. Goodbye!`;
}

function getActiveSessions() { return sessions.size; }

// Builds and caches the system prompt during /ivr-select so turn-1 /gather has no prompt-build cost
function prewarmSession(callSid) {
  const session = sessions.get(callSid);
  if (!session || session.cachedSystemPrompt) return;
  let sp = buildSystemPrompt(session.clinic);
  if (session.selectedCenter && !session.kb) {
    sp += `\n\n## Selected Location\nThe patient selected the ${session.selectedCenter.label}. Direct all scheduling, messages, transfers, and voicemail to this location.`;
  }
  if (session.kb) {
    sp += buildKbPromptSection(session.kb, session.selectedCenter);
  }
  session.cachedSystemPrompt = sp;
  console.log(`[AI] Session prewarmed  CallSid=${callSid}`);
}

// ── KB test (stateless — for Super Admin simulator) ───────────────────────────

async function runKbTest(clinic, kb, question) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  let systemPrompt = buildSystemPrompt(clinic);
  if (kb) systemPrompt += buildKbPromptSection(kb, null);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 400,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: question }],
  });

  const rawText = response.content[0].text.trim();
  let parsed;
  try {
    const jsonStr = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsed = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? jsonStr);
  } catch {
    parsed = { speak: rawText.substring(0, 500), unanswered: false, emergencyDetected: false };
  }

  return {
    response:          parsed.speak || rawText.substring(0, 500),
    unanswered:        parsed.unanswered        || false,
    emergencyDetected: parsed.emergencyDetected || false,
    intent:            parsed.intent            || 'unknown',
  };
}

module.exports = {
  INDUSTRY_TEMPLATES,
  buildSystemPrompt,
  getActiveSessions,
  prewarmSession,
  initSession,
  getSession,
  setSessionDbId,
  endSession,
  setSelectedCenter,
  setSessionLanguage,
  incrementIvrTimeouts,
  processMessage,
  runTestMessage,
  runKbTest,
  buildKbPromptSection,
  getInitialGreeting,
  getSpanishGreeting,
  getErrorMessage,
  getNoInputMessage,
  getTimeoutGoodbye,
};
