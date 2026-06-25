const cron = require('node-cron');
const { getAppointmentsDueForReminder, markReminderSent, getClinicById } = require('../database/db');
const { sendAppointmentReminderSms } = require('./email');

function isoWindow(hoursAhead, toleranceMinutes = 5) {
  const center = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  const start  = new Date(center.getTime() - toleranceMinutes * 60 * 1000);
  const end    = new Date(center.getTime() + toleranceMinutes * 60 * 1000);
  const fmt    = d => d.toISOString().replace('T', ' ').slice(0, 19);
  return { start: fmt(start), end: fmt(end) };
}

async function runReminders(reminderType, hoursAhead) {
  const { start, end } = isoWindow(hoursAhead);
  let rows;
  try {
    rows = getAppointmentsDueForReminder(reminderType, start, end);
  } catch (e) {
    console.error(`[Scheduler] DB error fetching ${reminderType} reminders:`, e.message);
    return;
  }

  if (!rows.length) return;
  console.log(`[Scheduler] ${reminderType} reminders: ${rows.length} appointment(s) due`);

  for (const appt of rows) {
    try {
      const clinic = getClinicById(appt.clinic_id);
      if (!clinic) continue;

      await sendAppointmentReminderSms(
        clinic,
        appt.patient_phone,
        appt.patient_name,
        appt.location,
        appt.preferred_date,
        appt.preferred_time,
        appt.language || 'en',
        hoursAhead,
      );

      markReminderSent(appt.id, reminderType);
      console.log(`[Scheduler] ${reminderType} reminder sent → appt #${appt.id} (${appt.patient_name})`);
    } catch (e) {
      console.error(`[Scheduler] Failed ${reminderType} reminder for appt #${appt.id}:`, e.message);
    }
  }
}

function startScheduler() {
  // Run every 5 minutes — check both reminder windows each tick
  cron.schedule('*/5 * * * *', async () => {
    await runReminders('24h', 24);
    await runReminders('1h',  1);
  });

  console.log('[Scheduler] Appointment reminder job started (runs every 5 minutes)');
}

module.exports = { startScheduler };
