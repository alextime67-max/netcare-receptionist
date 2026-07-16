# NetCare Phone AI — Estado del Proyecto 2026-07-16

## Resumen ejecutivo

La migración completa de Twilio/OpenAI → Telnyx/Claude está desplegada en producción.
Las llamadas al número +16453007030 llegan, se contestan y Ana reproduce el saludo.
**Próximo trabajo:** investigar por qué la conversación termina después del saludo y no continúa.

---

## ✅ Qué funciona en producción hoy

### Flujo de llamada confirmado en logs

```
[Telnyx] call.initiated  ccid=…--Cpfg
[Telnyx/mdcare] Answered  from=+17866456114
[Telnyx/mdcare] Transcription started
[Telnyx/mdcare] Greeting: "Buenas noches. Gracias por llamar. ¿En qué puedo ayudarle hoy?"
[Telnyx] call.speak.ended
[Telnyx/mdcare] Call ended  duration=14s  turns=1
```

| Punto del flujo | Estado |
|---|---|
| Webhook recibe `call.initiated` | ✅ |
| Clínica identificada por `telnyx_phone` | ✅ |
| Llamada contestada (`answer`) | ✅ |
| `transcription_start` enviado | ✅ |
| Saludo reproducido vía TTS Telnyx | ✅ |
| `call.speak.ended` recibido → estado WAITING | ✅ |
| Live Voice (browser chat SuperAdmin) | ✅ |
| Servidor PM2 estable | ✅ |
| Nginx `phone.netcaremiami.com` + `netcarephone.com` | ✅ |

### Infraestructura

| Dato | Valor |
|---|---|
| Servidor | Hetzner VPS `5.161.59.190` |
| Dominio webhook | `https://phone.netcaremiami.com/telnyx/webhook` |
| Número MDcare | `+16453007030` |
| PM2 proceso | `netcare-phone` — online |
| Commit en producción | `76eb8c4` |

---

## ❌ Problema activo — Conversación no continúa tras el saludo

**Síntoma:** La llamada dura ~14 segundos, 1 solo turno (el saludo). El paciente no puede hablar ni recibir respuesta de Ana.

**Estado del state machine cuando cuelga:**
- Saludo reproducido → `call.speak.ended` → estado cambia a `WAITING` ✅
- Paciente habla → se espera `call.transcription` con `is_final=true` → **no llega o es descartado**

### Hipótesis principales

**1. `transcription_start` sin `transcription_tracks` (más probable)**

En `src/routes/telnyx.js` la llamada actual es:
```javascript
await telnyxAction(callControlId, 'transcription_start', {
  transcription_engine: 'A',
  language: 'es',
}, apiKey);
```

No incluye `transcription_tracks`. La versión anterior del código tenía:
```javascript
transcription_tracks: 'inbound_track',
```

Sin este campo, Telnyx podría no enviar eventos `call.transcription` para el audio del paciente.

**2. Timing — paciente habla antes de que transcription_start sea ACK**

`transcription_start` se llama antes de `onCallAnswered()` (el speak del saludo). Hay una ventana donde el paciente podría hablar antes de que la transcripción esté activa.

**3. Evento `call.transcription` llega pero estado no es WAITING**

Si `call.speak.ended` llega después de que el paciente ya habló, el transcript sería descartado porque `state === 'GREETING'`.

### Próximos pasos recomendados

1. **Agregar `transcription_tracks: 'inbound_track'`** a `transcription_start` en `telnyx.js`
2. Verificar en Telnyx Debugging si llegan eventos `call.transcription` durante la llamada
3. Añadir log temporal para ver todos los eventos que llegan al webhook durante una llamada de prueba
4. Verificar que el `transcription_engine: 'A'` soporte español (`es`) — si no, cambiar a inglés para la prueba

---

## Arquitectura activa (post-migración)

```
Llamada entrante → Telnyx
  → POST https://phone.netcaremiami.com/telnyx/webhook
  → src/routes/telnyx.js

call.initiated  → identifica clínica por telnyx_phone (+16453007030 = mdcare)
                → answer()
call.answered   → createTelnyxRelay() + transcription_start()
                → onCallAnswered() → speak(greeting) [estado: GREETING]
call.speak.ended → estado: WAITING
call.transcription (is_final=true) → onTranscription(text)
                → Claude Haiku → JSON {lang, text} → speak(reply) [estado: RESPONDING]
call.speak.ended → estado: WAITING
...repite...
call.hangup     → cleanup() → updateCall(duration, status=completed)
```

### Stack

| Capa | Tecnología |
|---|---|
| Telefonía | Telnyx Call Control API (REST puro, sin WebSocket de audio) |
| AI | Claude Haiku `claude-haiku-4-5-20251001` |
| TTS | Telnyx `speak` — Adriana ES / Jacqueline EN |
| STT | Telnyx `transcription_start` → `call.transcription` events |
| Live Voice | WebSocket `/realtime/browser/:token` → Claude Sonnet texto |
| DB | SQLite via `better-sqlite3` |
| Proceso | PM2 `netcare-phone` en Hetzner VPS |

---

## Archivos clave de la migración

| Archivo | Rol |
|---|---|
| `src/routes/telnyx.js` | Handler único del webhook Telnyx |
| `src/services/realtime.js` | `createTelnyxRelay`, `createBrowserRelay`, `buildRealtimeInstructions` |
| `src/server.js` | Registro de rutas, WebSocket para Live Voice |
| `src/database/db.js` | Schema con columnas `telnyx_phone`, `telnyx_api_key`, `telnyx_voice` |
| `src/routes/webhook.js` | IVR Twilio legacy (sin código Telnyx) |

---

## Historial de commits de la migración

```
76eb8c4  Fix: restore correct webhook.js after bad merge (removed streaming_start)
907ae28  Merge branch 'telnyx-migration-wip'
36b8a32  Complete Telnyx integration and remove duplicate webhook handler
e9415e4  Migrate: Twilio/OpenAI → Telnyx/Claude (Phases 1–4)
```
