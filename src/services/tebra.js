/**
 * Tebra (formerly Kareo) EHR Integration — Stub / Future Implementation
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * INTEGRATION GUIDE FOR DEVELOPERS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Tebra exposes two API surfaces:
 *   1. SOAP API (legacy):  https://pm.kareo.com/api/soap/v2/
 *   2. REST API (current): https://api.tebra.com/  (requires separate OAuth)
 *
 * SOAP API Authentication (per request header):
 *   CustomerKey   = TEBRA_API_KEY env var
 *   PracticeName  = TEBRA_PRACTICE_NAME env var
 *   UserName      = TEBRA_USERNAME env var
 *   Password      = TEBRA_PASSWORD env var
 *
 * Install when ready:
 *   npm install soap          ← for SOAP API
 *   npm install axios         ← for REST API (already common dep)
 *
 * Key operations this stub prepares:
 *   findPatient()      → GetPatients / SearchPatients
 *   createPatient()    → CreatePatient
 *   createAppointment()→ CreateAppointment
 *   syncAppointment()  → orchestrates all three
 *
 * DB columns already reserved for Tebra IDs:
 *   appointments.tebra_appointment_id
 *   appointments.tebra_patient_id
 * ══════════════════════════════════════════════════════════════════════════════
 */

const ENABLED = !!(process.env.TEBRA_API_KEY && process.env.TEBRA_PRACTICE_NAME);

if (ENABLED) {
  console.log('[Tebra] Integration enabled — credentials present.');
} else {
  console.log('[Tebra] Integration disabled (no credentials). Running in stub mode.');
}

// ── SOAP client helper (uncomment when implementing) ─────────────────────────
// const soap = require('soap');
// const WSDL = 'https://pm.kareo.com/api/soap/v2/?wsdl';
// let _client;
// async function getSoapClient() {
//   if (!_client) _client = await soap.createClientAsync(WSDL);
//   return _client;
// }
// function requestHeader() {
//   return {
//     CustomerKey: process.env.TEBRA_API_KEY,
//     User: {
//       PracticeName: process.env.TEBRA_PRACTICE_NAME,
//       UserName:     process.env.TEBRA_USERNAME,
//       Password:     process.env.TEBRA_PASSWORD,
//     },
//   };
// }

/**
 * Search for an existing Tebra patient by last name + phone.
 * Returns patient object with { tebraPatientId } or null.
 */
async function findPatient({ name, phone }) {
  if (!ENABLED) {
    console.log('[Tebra:stub] findPatient', { name, phone });
    return null;
  }

  // TODO: implement
  // const client = await getSoapClient();
  // const [result] = await client.GetPatientsAsync({
  //   request: {
  //     RequestHeader: requestHeader(),
  //     Fields: {
  //       LastName:    name.split(' ').slice(-1)[0],
  //       PhoneNumber: phone,
  //     },
  //   },
  // });
  // const patients = result?.GetPatientsResult?.Patients ?? [];
  // const match = patients[0];
  // return match ? { tebraPatientId: match.PatientID, ...match } : null;

  throw new Error('Tebra findPatient not yet implemented — stub only');
}

/**
 * Create a new patient record in Tebra.
 * Returns { tebraPatientId }.
 */
async function createPatient({ name, phone }) {
  if (!ENABLED) {
    console.log('[Tebra:stub] createPatient', { name, phone });
    return { tebraPatientId: null };
  }

  // TODO: implement
  // const parts = name.trim().split(/\s+/);
  // const client = await getSoapClient();
  // const [result] = await client.CreatePatientAsync({
  //   request: {
  //     RequestHeader: requestHeader(),
  //     Patient: {
  //       FirstName:   parts[0],
  //       LastName:    parts.slice(1).join(' ') || parts[0],
  //       MobilePhone: phone,
  //     },
  //   },
  // });
  // return { tebraPatientId: result?.CreatePatientResult?.PatientID };

  throw new Error('Tebra createPatient not yet implemented — stub only');
}

/**
 * Create an appointment in Tebra.
 * Returns { tebraAppointmentId }.
 */
async function createAppointment({ tebraPatientId, date, time, reason }) {
  if (!ENABLED) {
    console.log('[Tebra:stub] createAppointment', { tebraPatientId, date, time, reason });
    return { tebraAppointmentId: null };
  }

  // TODO: implement
  // const client = await getSoapClient();
  // const startDateTime = `${date}T${time || '09:00'}:00`;
  // const [result] = await client.CreateAppointmentAsync({
  //   request: {
  //     RequestHeader: requestHeader(),
  //     Appointment: {
  //       PatientID:         tebraPatientId,
  //       StartDateTime:     startDateTime,
  //       AppointmentTypeID: process.env.TEBRA_DEFAULT_APPT_TYPE || '1',
  //       Description:       reason,
  //       Duration:          30,  // minutes
  //     },
  //   },
  // });
  // return { tebraAppointmentId: result?.CreateAppointmentResult?.AppointmentID };

  throw new Error('Tebra createAppointment not yet implemented — stub only');
}

/**
 * Full sync flow: find-or-create patient then create appointment.
 * Called after a call is finalized. Non-fatal if it fails.
 */
async function syncAppointmentToTebra(appointmentData) {
  try {
    let patient = await findPatient({
      name:  appointmentData.patient_name,
      phone: appointmentData.patient_phone,
    });

    if (!patient) {
      patient = await createPatient({
        name:  appointmentData.patient_name,
        phone: appointmentData.patient_phone,
      });
    }

    const appt = await createAppointment({
      tebraPatientId: patient.tebraPatientId,
      date:           appointmentData.preferred_date,
      time:           appointmentData.preferred_time,
      reason:         appointmentData.reason,
    });

    return {
      success:             true,
      tebraAppointmentId:  appt.tebraAppointmentId,
      tebraPatientId:      patient.tebraPatientId,
    };
  } catch (err) {
    console.error('[Tebra] Sync failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isEnabled:              () => ENABLED,
  findPatient,
  createPatient,
  createAppointment,
  syncAppointmentToTebra,
};
