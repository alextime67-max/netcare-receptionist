/**
 * Injects Phase 6 JavaScript into superadmin.html
 * Run from project root: node scripts/inject-phase6-js.js
 */
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../src/public/superadmin.html');
let c = fs.readFileSync(htmlPath, 'utf8');

const MARKER = '// ── SVG icons ─────────────────────────────────────────────────────────────────';

if (!c.includes(MARKER)) {
  console.error('ERROR: Marker not found in superadmin.html');
  process.exit(1);
}

if (c.includes('// ── Call Log ─────')) {
  console.log('Phase 6 JS already injected, skipping.');
  process.exit(0);
}

const newJS = `// ── Call Log ─────────────────────────────────────────────────────────────────

let callLogOffset = 0;
const CALL_LOG_LIMIT = 50;
let callLogTotal = 0;

async function loadCallLog() {
  callLogOffset = 0;
  await fetchCallLog();
}

async function fetchCallLog() {
  const tbody      = document.getElementById('call-log-tbody');
  const countEl   = document.getElementById('call-log-count');
  const pagination = document.getElementById('call-log-pagination');
  tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400 text-sm">Loading…</td></tr>';

  const params = new URLSearchParams({ limit: CALL_LOG_LIMIT, offset: callLogOffset });
  const clinic = document.getElementById('call-filter-clinic').value;
  const status = document.getElementById('call-filter-status').value;
  const start  = document.getElementById('call-filter-start').value;
  const end    = document.getElementById('call-filter-end').value;
  if (clinic) params.set('clinicId', clinic);
  if (status) params.set('status',   status);
  if (start)  params.set('startDate', start);
  if (end)    params.set('endDate',   end);

  try {
    const data = await (await fetch('/superadmin/api/calls?' + params)).json();
    callLogTotal = data.total;
    countEl.textContent = callLogTotal.toLocaleString() + ' calls total';

    if (!data.calls.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400 text-sm">No calls found</td></tr>';
      pagination.classList.add('hidden');
      return;
    }

    const statusBadge = s => ({
      completed:   '<span class="badge bg-emerald-50 text-emerald-700">Completed</span>',
      in_progress: '<span class="badge bg-blue-50 text-blue-700">Active</span>',
      abandoned:   '<span class="badge bg-slate-100 text-slate-500">Abandoned</span>',
      transferred: '<span class="badge bg-indigo-50 text-indigo-700">Transferred</span>',
      emergency:   '<span class="badge bg-red-50 text-red-700">Emergency</span>',
    }[s] || '<span class="badge bg-slate-100 text-slate-600">' + (s||'—') + '</span>');

    tbody.innerHTML = data.calls.map(call => {
      const ts   = new Date(call.created_at).toLocaleString();
      const dur  = call.duration ? (call.duration + 's') : '—';
      const type = { appointment:'Appt', message:'Msg', unknown:'—', transfer:'Transfer' }[call.call_type] || call.call_type || '—';
      return '<tr class="border-t border-slate-100 hover:bg-slate-50 text-sm">' +
        '<td class="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">' + ts + '</td>' +
        '<td class="px-4 py-3 font-medium">' + (call.clinic_name || '—') + '</td>' +
        '<td class="px-4 py-3 font-mono text-xs">' + (call.caller_number || '—') + '</td>' +
        '<td class="px-4 py-3">' + (call.patient_name || '—') + '</td>' +
        '<td class="px-4 py-3 text-xs">' + type + '</td>' +
        '<td class="px-4 py-3 text-xs">' + dur + '</td>' +
        '<td class="px-4 py-3">' + statusBadge(call.status) + '</td>' +
        '<td class="px-4 py-3"><button onclick="viewCallDetail(' + call.id + ')" class="text-xs text-blue-600 hover:underline">Transcript</button></td>' +
        '</tr>';
    }).join('');

    const totalPages = Math.ceil(callLogTotal / CALL_LOG_LIMIT);
    const page = Math.floor(callLogOffset / CALL_LOG_LIMIT) + 1;
    document.getElementById('call-log-page-info').textContent = 'Page ' + page + ' of ' + totalPages;
    document.getElementById('call-log-prev').disabled = callLogOffset === 0;
    document.getElementById('call-log-next').disabled = callLogOffset + CALL_LOG_LIMIT >= callLogTotal;
    pagination.classList.toggle('hidden', totalPages <= 1);
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-red-400 text-sm">' + e.message + '</td></tr>';
  }
}

function callLogPage(dir) {
  callLogOffset = Math.max(0, callLogOffset + dir * CALL_LOG_LIMIT);
  fetchCallLog();
}

function clearCallFilters() {
  ['call-filter-clinic','call-filter-status','call-filter-start','call-filter-end']
    .forEach(id => { document.getElementById(id).value = ''; });
  loadCallLog();
}

async function viewCallDetail(callId) {
  try {
    const data  = await (await fetch('/superadmin/api/calls/' + callId)).json();
    const modal = document.getElementById('call-detail-modal');
    const body  = document.getElementById('call-detail-body');

    const ts = new Date(data.created_at).toLocaleString();

    let transcriptHtml = '';
    if (data.transcript && data.transcript.length) {
      const rows = data.transcript.map(t => {
        const isAI = t.role === 'assistant';
        return '<div class="flex gap-2 ' + (isAI ? '' : 'flex-row-reverse') + '">' +
          '<div class="text-xs rounded-lg px-3 py-2 max-w-xs ' + (isAI ? 'bg-slate-100 text-slate-700' : 'bg-blue-600 text-white') + '">' +
          escHtml(t.content) + '</div></div>';
      }).join('');
      transcriptHtml = '<div class="mt-4"><p class="text-xs font-semibold text-slate-500 uppercase mb-2">Transcript</p>' +
        '<div class="space-y-2 max-h-72 overflow-y-auto">' + rows + '</div></div>';
    }

    body.innerHTML =
      '<div class="grid grid-cols-2 gap-3 text-sm">' +
        '<div><span class="text-xs text-slate-400">Clinic</span><div class="font-medium">' + (data.clinic_name || data.clinic_id) + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Date</span><div>' + ts + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Caller</span><div class="font-mono">' + (data.caller_number || '—') + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Patient</span><div>' + (data.patient_name || '—') + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Call Type</span><div>' + (data.call_type || '—') + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Duration</span><div>' + (data.duration ? data.duration + 's' : '—') + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Language</span><div>' + (data.language === 'es' ? 'Spanish' : 'English') + '</div></div>' +
        '<div><span class="text-xs text-slate-400">Status</span><div>' + (data.status || '—') + '</div></div>' +
      '</div>' + transcriptHtml;

    modal.classList.remove('hidden');
  } catch(e) { alert('Could not load call: ' + e.message); }
}

function closeCallDetail() {
  document.getElementById('call-detail-modal').classList.add('hidden');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Populate clinic filter dropdown ──────────────────────────────────────────

function populateCallClinicFilter() {
  const sel = document.getElementById('call-filter-clinic');
  if (!sel || !allClients) return;
  sel.innerHTML = '<option value="">All Clinics</option>' +
    allClients.map(c => '<option value="' + c.id + '">' + escHtml(c.name) + '</option>').join('');
}

// ── Twilio credential test ────────────────────────────────────────────────────

async function testTwilioCredentials() {
  const id = document.getElementById('edit-id').value;
  if (!id) { alert('Save the clinic first before testing credentials.'); return; }
  const btn = document.getElementById('twilio-test-btn');
  const res = document.getElementById('twilio-test-result');
  btn.disabled = true; btn.textContent = 'Validating…';
  res.className = 'hidden mt-2 text-xs rounded-lg p-3 border';
  try {
    const r    = await fetch('/superadmin/api/clinics/' + id + '/twilio/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        twilioSid:   document.getElementById('f-twilio-sid').value.trim(),
        twilioToken: document.getElementById('f-twilio-token').value.trim(),
        twilioPhone: document.getElementById('f-twilio-phone').value.trim(),
      }),
    });
    const data = await r.json();
    if (data.ok) {
      const pn = data.phoneNumber;
      const phoneExtra = pn && !pn.error
        ? '<br><strong>Phone:</strong> ' + pn.phoneNumber + ' (' + pn.friendlyName + ') — voice: ' + (pn.capabilities && pn.capabilities.voice ? '✓' : '✗')
        : (pn && pn.error ? '<br>⚠ ' + pn.error : '');
      res.innerHTML = '<strong>✓ Valid!</strong> Account: ' + data.account.friendlyName + ' (' + data.account.status + ')' + phoneExtra;
      res.className = 'mt-2 text-xs rounded-lg p-3 border bg-emerald-50 text-emerald-700 border-emerald-200';
    } else {
      res.textContent = '✗ ' + (data.error || 'Invalid credentials');
      res.className = 'mt-2 text-xs rounded-lg p-3 border bg-red-50 text-red-700 border-red-200';
    }
  } catch(e) {
    res.textContent = '✗ ' + e.message;
    res.className = 'mt-2 text-xs rounded-lg p-3 border bg-red-50 text-red-700 border-red-200';
  } finally {
    btn.disabled = false; btn.textContent = 'Validate Credentials';
  }
}

async function makeTestCall() {
  const id    = document.getElementById('edit-id').value;
  const phone = document.getElementById('twilio-test-phone').value.trim();
  if (!id)    { alert('Save the clinic first.'); return; }
  if (!phone) { alert('Enter a phone number to call.'); return; }
  const btn = document.getElementById('twilio-call-btn');
  const res = document.getElementById('twilio-call-result');
  btn.disabled = true; btn.textContent = 'Calling…';
  res.className = 'hidden mt-2 text-xs rounded-lg p-3 border';
  try {
    const r    = await fetch('/superadmin/api/clinics/' + id + '/twilio/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testPhone: phone }),
    });
    const data = await r.json();
    if (data.ok) {
      res.textContent = '📞 Call initiated! SID: ' + data.callSid;
      res.className = 'mt-2 text-xs rounded-lg p-3 border bg-emerald-50 text-emerald-700 border-emerald-200';
    } else {
      res.textContent = '✗ ' + (data.error || 'Failed');
      res.className = 'mt-2 text-xs rounded-lg p-3 border bg-red-50 text-red-700 border-red-200';
    }
  } catch(e) {
    res.textContent = '✗ ' + e.message;
    res.className = 'mt-2 text-xs rounded-lg p-3 border bg-red-50 text-red-700 border-red-200';
  } finally {
    btn.disabled = false; btn.textContent = '📞 Call Me';
  }
}

// ── Webhook Call Simulator ────────────────────────────────────────────────────

let wsimCallSid = null;
let wsimActive  = false;
let wsimSlug    = null;

function resetWebhookSim() {
  wsimCallSid = null; wsimActive = false;
  const chat = document.getElementById('wsim-chat');
  chat.innerHTML = '<div class="flex-1 flex items-center justify-center text-xs text-slate-400 text-center p-4">Click <strong class=\'mx-1\'>Start Call</strong> to simulate an inbound call</div>';
  document.getElementById('wsim-input').value = '';
  document.getElementById('wsim-input').disabled = true;
  document.getElementById('wsim-send-btn').disabled = true;
  document.getElementById('wsim-start-btn').disabled = false;
  document.getElementById('wsim-start-btn').textContent = 'Start Call';
  document.getElementById('wsim-start-btn').onclick = startWebhookSim;
  const err = document.getElementById('wsim-error');
  if (err) err.classList.add('hidden');
}

async function startWebhookSim() {
  const clinicId = document.getElementById('edit-id').value;
  const clinicData = allClients && allClients.find(function(cl) { return cl.id === +clinicId; });
  if (!clinicData) { alert('Save the clinic first.'); return; }
  wsimSlug    = clinicData.slug;
  wsimCallSid = 'SIM_' + Date.now();
  wsimActive  = true;

  document.getElementById('wsim-start-btn').disabled = true;
  document.getElementById('wsim-start-btn').textContent = 'In Progress…';
  const errEl = document.getElementById('wsim-error');
  if (errEl) errEl.classList.add('hidden');
  document.getElementById('wsim-chat').innerHTML = '';

  try {
    const r = await fetch('/webhook/' + wsimSlug + '/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: wsimCallSid, From: '+15550000000', To: '+15559999999' }),
    });
    const twiml = await r.text();
    const text  = parseSayText(twiml);
    wsimAppendBubble('ai', text || '[AI spoke]');

    if (twiml.includes('<Hangup') || twiml.includes('<Dial')) {
      wsimAppendBubble('system', twiml.includes('<Dial') ? '📞 Call transferred.' : '📴 Call ended.');
      wsimActive = false;
      document.getElementById('wsim-start-btn').textContent = 'New Call';
      document.getElementById('wsim-start-btn').onclick = resetWebhookSim;
      document.getElementById('wsim-start-btn').disabled = false;
    } else {
      document.getElementById('wsim-input').disabled = false;
      document.getElementById('wsim-send-btn').disabled = false;
      document.getElementById('wsim-input').focus();
      document.getElementById('wsim-start-btn').textContent = 'Restart';
      document.getElementById('wsim-start-btn').onclick = resetWebhookSim;
      document.getElementById('wsim-start-btn').disabled = false;
    }
  } catch(e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    wsimActive = false;
    document.getElementById('wsim-start-btn').disabled = false;
    document.getElementById('wsim-start-btn').textContent = 'Start Call';
    document.getElementById('wsim-start-btn').onclick = startWebhookSim;
  }
}

async function sendWebhookSim() {
  if (!wsimActive || !wsimSlug) return;
  const input = document.getElementById('wsim-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';
  input.disabled = true;
  document.getElementById('wsim-send-btn').disabled = true;
  const errEl = document.getElementById('wsim-error');
  if (errEl) errEl.classList.add('hidden');
  wsimAppendBubble('user', text);

  try {
    const r = await fetch('/webhook/' + wsimSlug + '/gather', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: wsimCallSid, SpeechResult: text, Confidence: '0.9' }),
    });
    const twiml  = await r.text();
    const spoken = parseSayText(twiml);
    wsimAppendBubble('ai', spoken || '[no speech]');

    if (twiml.includes('<Hangup') || twiml.includes('<Dial')) {
      const dialMatch = twiml.match(/<Dial[^>]*>([^<]+)/);
      wsimAppendBubble('system', twiml.includes('<Dial')
        ? '📞 Transferred to ' + (dialMatch ? dialMatch[1] : 'transfer number') + '.'
        : '📴 Call ended.');
      wsimActive = false;
      input.disabled = true;
      document.getElementById('wsim-send-btn').disabled = true;
      document.getElementById('wsim-start-btn').textContent = 'New Call';
      document.getElementById('wsim-start-btn').onclick = resetWebhookSim;
      document.getElementById('wsim-start-btn').disabled = false;
    } else {
      input.disabled = false;
      document.getElementById('wsim-send-btn').disabled = false;
      input.focus();
    }
  } catch(e) {
    if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    input.disabled = false;
    document.getElementById('wsim-send-btn').disabled = false;
  }
}

function parseSayText(twiml) {
  const m = twiml.match(/<Say[^>]*>([\s\S]*?)<\/Say>/i);
  if (!m) return '';
  return m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}

function wsimAppendBubble(role, text) {
  const chat = document.getElementById('wsim-chat');
  const el   = document.createElement('div');
  if (role === 'system') {
    el.className = 'text-center text-xs text-slate-400 italic py-1';
    el.textContent = text;
  } else {
    const isAI = role === 'ai';
    el.className = 'flex gap-2 ' + (isAI ? '' : 'flex-row-reverse');
    const lbl    = document.createElement('div');
    lbl.className = 'text-xs text-slate-400 self-end mb-0.5 flex-shrink-0';
    lbl.textContent = isAI ? '🤖' : '👤';
    const bubble = document.createElement('div');
    bubble.className = 'text-xs rounded-lg px-3 py-2 max-w-xs break-words ' +
      (isAI ? 'bg-slate-100 text-slate-700' : 'bg-blue-600 text-white');
    bubble.textContent = text;
    if (isAI) { el.appendChild(lbl); el.appendChild(bubble); }
    else       { el.appendChild(bubble); el.appendChild(lbl); }
  }
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

// ── Live stats (active call counter) ─────────────────────────────────────────

async function refreshLiveStats() {
  try {
    const data = await (await fetch('/superadmin/api/stats/live')).json();
    const el = document.getElementById('live-active-calls');
    if (el) el.textContent = data.activeSessions;
  } catch(_) {}
}
setInterval(refreshLiveStats, 10000);
refreshLiveStats();

`;

c = c.replace(MARKER, newJS + MARKER);
fs.writeFileSync(htmlPath, c, 'utf8');
console.log('Phase 6 JS injected successfully.');
