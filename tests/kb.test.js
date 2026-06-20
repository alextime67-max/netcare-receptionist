const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

// Import db helpers directly — no server needed
const {
  initDb,
  getClinics,
  getKnowledgeBase,
  upsertKnowledgeBase,
  logUnansweredQuestion,
  getUnansweredQuestions,
} = require('../src/database/db');

// Ensure tables exist (server normally calls initDb on startup)
initDb();

const { buildKbPromptSection } = require('../src/services/ai');

let clinic;
let testClinicId;

describe('Knowledge Base — DB helpers', () => {

  before(() => {
    const clinics = getClinics();
    // Use MDcare if seeded, otherwise the first clinic
    clinic = clinics.find(c => c.slug === 'mdcare') || clinics[0];
    if (!clinic) throw new Error('No clinic in DB — run the server once to seed');
    testClinicId = clinic.id;
  });

  test('getKnowledgeBase returns an object for seeded clinic', () => {
    const kb = getKnowledgeBase(testClinicId);
    assert.ok(kb, 'KB should not be null for MDcare');
    assert.equal(kb.clinic_id, testClinicId);
  });

  test('upsertKnowledgeBase can create or overwrite a field', () => {
    const before = getKnowledgeBase(testClinicId);
    const marker = `test-${Date.now()}`;
    // Pass full object so other fields are preserved on restore
    upsertKnowledgeBase(testClinicId, { ...(before || {}), faqs: marker });
    const after = getKnowledgeBase(testClinicId);
    assert.equal(after.faqs, marker);
    // restore full KB
    if (before) upsertKnowledgeBase(testClinicId, before);
  });

  test('logUnansweredQuestion inserts a row', () => {
    const before = getUnansweredQuestions(testClinicId, 200, 0);
    logUnansweredQuestion(testClinicId, null, 'unit-test-question-xyz');
    const after = getUnansweredQuestions(testClinicId, 200, 0);
    assert.equal(after.length, before.length + 1);
    const found = after.find(r => r.question === 'unit-test-question-xyz');
    assert.ok(found);
  });

  test('getUnansweredQuestions respects limit', () => {
    const rows = getUnansweredQuestions(testClinicId, 2, 0);
    assert.ok(rows.length <= 2);
  });

  test('getUnansweredQuestions returns zero rows for unknown clinic id', () => {
    const rows = getUnansweredQuestions(99999, 50, 0);
    assert.equal(rows.length, 0);
  });
});

describe('Knowledge Base — Prompt Builder', () => {

  test('buildKbPromptSection returns a string with medical safety rule', () => {
    const kb = { services: 'General medicine', do_not_answer: 'Dosage questions' };
    const section = buildKbPromptSection(kb, null);
    assert.ok(typeof section === 'string');
    assert.ok(section.includes('MEDICAL SAFETY') || section.includes('medical advice') || section.includes('911'));
  });

  test('buildKbPromptSection includes services when provided', () => {
    const kb = { services: 'Cardiology, Pediatrics' };
    const section = buildKbPromptSection(kb, null);
    assert.ok(section.includes('Cardiology'));
  });

  test('buildKbPromptSection includes do_not_answer topics', () => {
    const kb = { do_not_answer: 'Medication dosages, Legal questions' };
    const section = buildKbPromptSection(kb, null);
    assert.ok(section.includes('Medication dosages'));
  });

  test('buildKbPromptSection injects selectedCenter label', () => {
    const kb = { locations: 'Hialeah: 100 Main St' };
    const center = { label: 'Hialeah Medical Center', address: '100 Main St, Hialeah FL' };
    const section = buildKbPromptSection(kb, center);
    assert.ok(section.includes('Hialeah Medical Center'));
  });

  test('buildKbPromptSection handles null kb gracefully', () => {
    assert.doesNotThrow(() => buildKbPromptSection(null, null));
  });

  test('buildKbPromptSection handles empty kb object', () => {
    const section = buildKbPromptSection({}, null);
    assert.ok(typeof section === 'string');
  });
});
