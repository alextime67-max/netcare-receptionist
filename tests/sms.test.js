/**
 * Tests for SMS service logic (Phase 7)
 * Verifies guard conditions without making real Twilio calls.
 */
const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Minimal SMS logic replicated for unit testing ─────────────────────────────

async function sendSmsFollowUp(clinic, toPhone, message, sender) {
  if (!clinic?.sms_follow_up_enabled) return null;
  if (!clinic.twilio_phone || !clinic.twilio_sid || !clinic.twilio_token) return null;
  if (!toPhone || !toPhone.trim() || toPhone === 'anonymous') return null;
  return sender(clinic.twilio_phone, toPhone, message);
}

async function sendAppointmentConfirmationSms(clinic, toPhone, patientName, date, time, sender) {
  const details = [date, time].filter(Boolean).join(' at ');
  const name    = patientName || 'there';
  const message =
    `Hi ${name}, your appointment request at ${clinic.name} has been received` +
    `${details ? ` for ${details}` : ''}. We will confirm shortly. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message, sender);
}

async function sendMissedCallSms(clinic, toPhone, sender) {
  const callBackAt = clinic.phone_display || clinic.twilio_phone || 'our office';
  const message =
    `You recently missed a call from ${clinic.name}. ` +
    `Please call us back at ${callBackAt} when you get a chance. Reply STOP to opt out.`;
  return sendSmsFollowUp(clinic, toPhone, message, sender);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeClinic(overrides = {}) {
  return {
    name:                 'Test Clinic',
    twilio_phone:         '+15550001234',
    twilio_sid:           'ACtest',
    twilio_token:         'tokentest',
    sms_follow_up_enabled: 1,
    phone_display:        '(555) 000-1234',
    ...overrides,
  };
}

function makeSender() {
  const calls = [];
  const fn = async (from, to, body) => { calls.push({ from, to, body }); return 'SM_test_sid'; };
  fn.calls = calls;
  return fn;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('sendSmsFollowUp skips when sms_follow_up_enabled is false', async () => {
  const sender = makeSender();
  const clinic = makeClinic({ sms_follow_up_enabled: 0 });
  const result = await sendSmsFollowUp(clinic, '+15551234567', 'Hello', sender);
  assert.equal(result, null);
  assert.equal(sender.calls.length, 0);
});

test('sendSmsFollowUp skips when twilio_phone is missing', async () => {
  const sender = makeSender();
  const clinic = makeClinic({ twilio_phone: null });
  const result = await sendSmsFollowUp(clinic, '+15551234567', 'Hello', sender);
  assert.equal(result, null);
  assert.equal(sender.calls.length, 0);
});

test('sendSmsFollowUp skips when toPhone is anonymous', async () => {
  const sender = makeSender();
  const clinic = makeClinic();
  const result = await sendSmsFollowUp(clinic, 'anonymous', 'Hello', sender);
  assert.equal(result, null);
  assert.equal(sender.calls.length, 0);
});

test('sendSmsFollowUp skips when toPhone is empty string', async () => {
  const sender = makeSender();
  const clinic = makeClinic();
  const result = await sendSmsFollowUp(clinic, '   ', 'Hello', sender);
  assert.equal(result, null);
  assert.equal(sender.calls.length, 0);
});

test('sendSmsFollowUp sends when all conditions are met', async () => {
  const sender = makeSender();
  const clinic = makeClinic();
  const result = await sendSmsFollowUp(clinic, '+15551234567', 'Test message', sender);
  assert.equal(result, 'SM_test_sid');
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].to,   '+15551234567');
  assert.equal(sender.calls[0].body, 'Test message');
});

test('sendAppointmentConfirmationSms includes date and time', async () => {
  const sender = makeSender();
  const clinic = makeClinic();
  await sendAppointmentConfirmationSms(clinic, '+15551234567', 'John', '2026-07-01', '10:00 AM', sender);
  assert.ok(sender.calls[0].body.includes('2026-07-01 at 10:00 AM'));
  assert.ok(sender.calls[0].body.includes('John'));
});

test('sendAppointmentConfirmationSms handles missing date gracefully', async () => {
  const sender = makeSender();
  const clinic = makeClinic();
  await sendAppointmentConfirmationSms(clinic, '+15551234567', 'Jane', null, null, sender);
  assert.ok(sender.calls[0].body.includes('been received'));
  assert.ok(!sender.calls[0].body.includes('undefined'));
});

test('sendMissedCallSms uses phone_display when available', async () => {
  const sender = makeSender();
  const clinic = makeClinic({ phone_display: '(555) 111-2222' });
  await sendMissedCallSms(clinic, '+15551234567', sender);
  assert.ok(sender.calls[0].body.includes('(555) 111-2222'));
});

test('sendMissedCallSms falls back to twilio_phone when phone_display missing', async () => {
  const sender = makeSender();
  const clinic = makeClinic({ phone_display: null });
  await sendMissedCallSms(clinic, '+15551234567', sender);
  assert.ok(sender.calls[0].body.includes('+15550001234'));
});
