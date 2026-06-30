# NetCare Phone AI — Guía Oficial del Proyecto

> Este archivo es la fuente de verdad para el desarrollo de NetCare Phone AI.
> Claude debe leerlo al inicio de cada sesión y seguir estas reglas durante todo el trabajo.

---

## 1. Objetivo del sistema

NetCare Phone AI es una **recepcionista médica virtual bilingüe (español / inglés)** que:

- Atiende llamadas telefónicas entrantes de clínicas médicas vía Twilio.
- Responde con voz natural generada por OpenAI Realtime (GPT-4o Realtime, voz `coral`).
- Detecta automáticamente el idioma del paciente y responde en el mismo idioma.
- Recopila datos del paciente (nombre, teléfono, motivo de consulta).
- Registra citas y mensajes en la base de datos.
- Permite pruebas de voz en tiempo real desde el panel de administración (Live Voice).
- Soporte multiempresa: cada clínica tiene su propia configuración, KB, voz y saludo.

**Dominio de producción:** `https://netcarephone.com`

---

## 2. Arquitectura del proyecto

### Stack técnico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js ≥ 18 |
| Framework web | Express 4 |
| Base de datos | SQLite via `better-sqlite3` |
| WebSocket | `ws` library (HTTP server upgrade manual) |
| Voz IA | OpenAI Realtime API (`gpt-realtime`) |
| Telefonía | Twilio Media Streams (G.711 μ-law) |
| Email | Nodemailer + SendGrid SMTP |
| Proceso | PM2 (`netcare-phone`) |
| Proxy | nginx (SSL termination → localhost:3000) |
| CI/CD | GitHub Actions → Hetzner VPS |

### Estructura de archivos

```
netcare-receptionist/
├── src/
│   ├── server.js              # Entry point. HTTP + WebSocket upgrade handler
│   ├── database/
│   │   └── db.js              # SQLite. initDb, getters, setters. camelCase→snake_case mapping
│   ├── routes/
│   │   ├── superadmin.js      # Panel Super Admin (CRUD clínicas, AI config, KB, training)
│   │   ├── webhook.js         # Twilio webhooks (voz legacy IVR + Realtime)
│   │   ├── admin.js           # Panel clínica (citas, mensajes)
│   │   ├── portal.js          # Portal paciente
│   │   ├── api.js             # API pública
│   │   └── public.js          # Recursos públicos
│   ├── services/
│   │   ├── realtime.js        # ★ Core IA: buildRealtimeInstructions, createTwilioRelay, createBrowserRelay
│   │   ├── ai.js              # Anthropic SDK (Train Ana, análisis)
│   │   ├── scheduler.js       # node-cron: recordatorios de citas
│   │   ├── email.js           # Notificaciones email
│   │   ├── sms.js             # SMS vía Twilio
│   │   ├── alerts.js          # Alertas internas
│   │   ├── costs.js           # Seguimiento de costos IA
│   │   └── tebra.js           # Integración Tebra EMR
│   └── public/
│       └── superadmin.html    # SPA del panel Super Admin
├── data/
│   └── netcare.db             # SQLite — NO versionar, NO tocar en prod directamente
├── .github/
│   └── workflows/
│       └── deploy.yml         # GitHub Actions: pull → install → restart → health check → rollback
├── .claude/
│   └── skills/
│       └── deploy.md          # Definición del comando "deploy"
├── CLAUDE.md                  # ← Este archivo
├── DEPLOYMENT.md              # Guía operativa de despliegue
├── ecosystem.config.js        # PM2 config
└── package.json
```

---

## 3. Estructura multiempresa

Cada empresa (clínica) es un registro en la tabla `clinics` con un `slug` único.

| Campo clave | Descripción |
|---|---|
| `slug` | Identificador URL-safe (`mdcare`, `netcare`) |
| `name` | Nombre para mostrar |
| `ai_assistant_name` | Nombre de la IA (ej: `Ana de MDcare`) |
| `openai_language` | Idioma primario: `es` o `en` |
| `openai_voice` | Voz OpenAI Realtime (ej: `coral`) |
| `ai_greeting_es` | Saludo en español (configurable por cliente) |
| `ai_greeting_en` | Saludo en inglés (configurable por cliente) |
| `ai_master_prompt` | Instrucciones maestras (mayor prioridad en el prompt) |
| `twilio_sid` / `twilio_token` | Credenciales Twilio por clínica |
| `twilio_phone` | Número Twilio asociado |
| `openai_api_key` | API key OpenAI por clínica (override del servidor) |

El Super Admin gestiona todas las clínicas. Cada clínica tiene su propio admin en `/admin/:slug`.

---

## 4. OpenAI Realtime

### Cómo funciona

1. El servidor abre una conexión WebSocket a `wss://api.openai.com/v1/realtime?model=gpt-realtime`.
2. Envía `session.update` con instrucciones, audio config y VAD.
3. Escucha eventos: `session.created`, `session.updated`, `response.audio.delta`, `response.done`, etc.
4. Reenvía audio hacia/desde el cliente (Twilio o browser).

### Función central: `buildRealtimeInstructions(clinic, kb)`

Ubicación: `src/services/realtime.js`

Construye el system prompt completo con:
- Identidad del asistente (`ai_assistant_name`, `name`)
- **Saludo configurable** (`ai_greeting_es` / `ai_greeting_en`) — fallback genérico si está vacío
- Reglas de detección automática de idioma
- Estilo conversacional
- Datos a recopilar del paciente
- KB (descripción, servicios, FAQ, reglas de negocio, Training FAQs, Training Sources)
- `ai_master_prompt` al final (máxima prioridad)

### Sesión OpenAI config

```javascript
model: 'gpt-4o-realtime-preview-2024-12-17'
voice: clinic.openai_voice || 'coral'       // NO cambiar sin instrucción
input_audio_format:  'g711_ulaw'            // Twilio
output_audio_format: 'g711_ulaw'            // Twilio
turn_detection: { type: 'server_vad' }      // VAD automático
```

### Regla crítica anti-double-response

- `greetingDone` flag: el audio del paciente NO se envía a OpenAI hasta que Ana termina su saludo inicial.
- El saludo se dispara con UN SOLO `response.create` en `session.updated`.
- NUNCA agregar un segundo `response.create` automático.

---

## 5. Twilio — Configuración

### Webhook URLs

| Tipo | URL |
|---|---|
| OpenAI Realtime (activo) | `POST https://netcarephone.com/webhook/:slug/realtime-voice` |
| Legacy IVR con Polly (antiguo) | `POST https://netcarephone.com/webhook/:slug/voice` |

**El número de Twilio de MDcare debe apuntar a `/realtime-voice`.**

### Flujo de llamada Twilio Realtime

```
Llamada entrante → Twilio webhook → TwiML <Connect><Stream>
  → wss://netcarephone.com/realtime/twilio/:slug
  → createTwilioRelay() en realtime.js
  → WebSocket a OpenAI Realtime
  → Audio G.711 μ-law bidireccional
```

### TwiML generado

```xml
<Response>
  <Connect>
    <Stream url="wss://netcarephone.com/realtime/twilio/mdcare" />
  </Connect>
</Response>
```

### Número de producción

- Número NetCare: `+18443145877` (variable `TWILIO_PHONE_NUMBER`)

### Credenciales por clínica

Guardadas en `clinics` tabla: `twilio_sid`, `twilio_token`, `twilio_phone`.
API acepta camelCase: `twilioSid`, `twilioToken`, `twilioPhone`.

---

## 6. Live Voice (browser)

Permite probar la voz de Ana en tiempo real desde el Super Admin sin necesidad de llamada telefónica.

### Flujo

```
SuperAdmin → POST /superadmin/api/clinics/:id/realtime/session
  → genera ws_token (UUID 32 chars, en memoria, 5 min TTL)
  → browser abre WebSocket wss://netcarephone.com/realtime/browser/:token
  → createBrowserRelay() en realtime.js
  → audio PCM 24kHz bidireccional (browser nativo)
```

### Diferencia con Twilio

| | Twilio | Live Voice |
|---|---|---|
| Audio format | G.711 μ-law (8kHz) | PCM 16-bit (24kHz) |
| Input | `audio/pcmu` | `audio/pcm16` |
| Output | `audio/pcmu` | `audio/pcm16` |
| Token | slug en URL | UUID en memoria |

### Importante

Los tokens son **en memoria**. Si PM2 reinicia, los tokens activos se pierden. El cliente debe solicitar un nuevo token.

---

## 7. Knowledge Base (KB)

Cada clínica tiene su KB compuesta de:

| Fuente | Tabla/Campo | Descripción |
|---|---|---|
| Descripción del negocio | `clinics.ai_business_description` | Texto libre |
| Servicios | `clinics.ai_services` | Lista de servicios |
| FAQ | `clinics.ai_faq` | JSON array `[{q, a}]` |
| Reglas de negocio | `business_rules` | Tabla separada por clínica |
| Training FAQs | `training_faqs` | Añadidas desde "Train Ana" |
| Training Sources | `training_sources` | URLs/documentos scrapeados |
| Master Prompt | `clinics.ai_master_prompt` | Instrucciones maestras (última, máxima prioridad) |

`buildRealtimeInstructions()` inyecta todo en el system prompt en ese orden. El `master_prompt` siempre va al final y sobreescribe cualquier instrucción anterior.

---

## 8. Base de datos

- **Motor:** SQLite via `better-sqlite3` (síncrono)
- **Archivo:** `data/netcare.db`
- **Init:** `initDb()` en `src/database/db.js` — crea tablas y agrega columnas faltantes con `_addColumnIfMissing`

### Regla camelCase ↔ snake_case

La API del SuperAdmin **acepta camelCase**. La DB usa **snake_case**. El mapeo está en:
- `updateClinicAiConfig()` → `greetingEn` → `ai_greeting_en`, `assistantName` → `ai_assistant_name`, etc.
- `updateClinic()` → `twilioSid` → `twilio_sid`, `twilioToken` → `twilio_token`, etc.

**Nunca pasar snake_case a la API** — el dato no se guarda aunque responda `ok: true`.

---

## 9. PM2

### Proceso

- **Nombre:** `netcare-phone`
- **Script:** `src/server.js`
- **Config:** `ecosystem.config.js`
- **Env:** lee `.env` via `env_file`

### Comandos útiles (en servidor)

```bash
pm2 list                                      # estado de todos los procesos
pm2 logs netcare-phone                        # logs en tiempo real
pm2 logs netcare-phone --lines 50 --nostream  # últimas 50 líneas
pm2 logs netcare-phone --err --lines 30 --nostream  # solo errores
pm2 restart netcare-phone                     # reiniciar
pm2 save                                      # persistir estado para reboot
```

### Persistencia

- systemd service `pm2-root` está `enabled` → PM2 arranca automáticamente tras reboot.
- `pm2 save` se ejecuta en cada deploy para actualizar el dump.

---

## 10. GitHub Actions — CI/CD

### Archivo

`.github/workflows/deploy.yml`

### Trigger

Push a rama `master`.

### Flujo del workflow

```
push a master
  → SSH a root@5.161.59.190
  → guarda PREV=$(git rev-parse HEAD)    # para rollback
  → git pull origin master
  → npm install --production --silent
  → pm2 restart netcare-phone
  → pm2 save
  → health check: curl localhost:3000/ (6 intentos × 5s)
    → 200 OK → exit 0  ✅
    → falla  → git reset --hard $PREV → npm install → pm2 restart → exit 1  ❌
```

### Secreto requerido

`SSH_PRIVATE_KEY` — configurado en:
`https://github.com/alextime67-max/netcare-receptionist/settings/secrets/actions`

### Verificar resultado

```bash
# En Hetzner — confirmar commit desplegado
ssh root@5.161.59.190 "cd /root/netcare-receptionist && git log --oneline -1"

# Health check externo
curl -s -o /dev/null -w "%{http_code}" https://netcarephone.com/
```

---

## 11. Hetzner VPS

| Dato | Valor |
|---|---|
| IP | `5.161.59.190` |
| Usuario SSH | `root` |
| Ruta del proyecto | `/root/netcare-receptionist` |
| Base de datos | `/root/netcare-receptionist/data/netcare.db` |
| Variables de entorno | `/root/netcare-receptionist/.env` |
| Logs PM2 | `~/.pm2/logs/netcare-phone-*.log` |
| Node.js | v18.19.1 |
| PM2 | v7.0.1 |

### Nginx

- Puerto 80 → redirect HTTPS
- Puerto 443 → proxy a `localhost:3000`
- WebSocket headers: `Upgrade`, `Connection: upgrade` — necesarios para Twilio y Live Voice
- SSL: Let's Encrypt (auto-renewal con certbot)
- Config: `/etc/nginx/sites-enabled/default`

---

## 12. Flujo de Git

```
Desarrollo local → test en localhost:3000 → aprobación → commit → push master → deploy automático
```

### Reglas de commit

```bash
git add <archivos específicos>    # NUNCA git add -A sin revisar
git commit -m "Descripción clara del cambio"
# Agregar al final del mensaje:
# Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
git push origin master
```

### Estilo de mensajes

- `Add:` — nueva funcionalidad
- `Fix:` — corrección de bug
- `Update:` — mejora de funcionalidad existente
- `Refactor:` — cambio sin impacto funcional
- `Docs:` — solo documentación

### Rama única

Solo existe `master`. No hay ramas de feature. Todo se prueba en local antes de publicar.

---

## 13. Comando `deploy`

Cuando el usuario escriba únicamente:

```
deploy
```

Claude ejecuta automáticamente las 6 fases definidas en `.claude/skills/deploy.md`:

1. **Validación** — syntax check de server.js, realtime.js, db.js
2. **Git** — status, diff, commit, push
3. **GitHub Actions** — esperar deploy, confirmar commit en Hetzner
4. **Producción** — PM2 online, health check HTTP 200, SuperAdmin accesible
5. **IA** — Live Voice session, greeting, instrucciones cargadas, logs sin errores
6. **Seguridad** — revisar logs por errores críticos

Termina con el reporte oficial:

```
========================================
✅ DEPLOY COMPLETADO
Commit:          <hash> — <mensaje>
GitHub Actions:  ✅
Hetzner:         <hash> online
PM2:             netcare-phone — online
Health Check:    HTTP 200
SuperAdmin:      200 OK
Live Voice:      ✅ session.created / Ana respondió
Twilio:          ✅ sin errores nuevos
Estado Final:    ✅ Producción actualizada correctamente.
========================================
```

---

## 14. Reglas de desarrollo

### Siempre

- Probar localmente en `http://localhost:3000` antes de hacer push.
- Usar `npm run dev` (nodemon) para desarrollo.
- Revisar `git diff` antes de commitear.
- Stagear solo los archivos modificados (`git add <archivo>`, nunca `git add .` sin revisar).
- Verificar Live Voice después de cualquier cambio en `realtime.js`.

### Nunca

- Hacer push sin haber probado el cambio localmente.
- Commitear `.env`, `data/netcare.db`, ni archivos con claves.
- Editar código directamente en el servidor (`/root/netcare-receptionist/src/`).
- Agregar `console.log` con API keys, tokens ni datos de pacientes.
- Cambiar el modelo OpenAI sin instrucción explícita del usuario.
- Cambiar la voz OpenAI (`coral`) sin instrucción explícita.
- Modificar la Knowledge Base de producción sin aprobación.
- Hacer `git add -A` sin revisar primero `git status`.

---

## 15. Reglas de producción

### Nunca modificar el servidor directamente

El servidor Hetzner es **solo lectura para código**. Todo cambio de código va por Git → GitHub Actions → deploy automático.

**Excepciones permitidas (con cuidado):**

| Acción | Comando seguro |
|---|---|
| Editar `.env` | `nano /root/netcare-receptionist/.env` (siempre con respaldo previo) |
| Ver logs | `pm2 logs netcare-phone` |
| Reiniciar manual (emergencia) | `pm2 restart netcare-phone` |
| Rollback manual | `git reset --hard <HASH>` + `pm2 restart netcare-phone` |

### Archivos que NUNCA tocar en el servidor

- `src/**` — se sobreescriben en el próximo pull
- `package.json`, `package-lock.json` — ídem
- `data/netcare.db` con SQL directo — sin respaldo, sin historial
- Configuración de nginx sin documentar el cambio

---

## 16. Reglas de seguridad

- **Base de datos de producción:** NUNCA sobrescribir sin aprobación explícita del usuario.
- **Datos reales:** NUNCA borrar call logs, KB de clientes, AI configs existentes.
- **Funcionalidad existente:** NUNCA romper Live Voice, Twilio Realtime, KB, ni Test Ana.
- **Commits:** NUNCA publicar con errores de sintaxis o errores críticos sin resolver.
- **Claves:** NUNCA exponer OpenAI API key, Twilio credentials, SSH key en logs ni respuestas.
- **Cambios funcionales:** NUNCA hacer commit hasta que el usuario pruebe y apruebe.
- **Deploy con errores:** Si el health check falla, el workflow hace rollback automático.

### Variables sensibles

| Variable | Dónde vive |
|---|---|
| `OPENAI_API_KEY` | `.env` en servidor (nunca en código) |
| `TWILIO_ACCOUNT_SID` | `.env` en servidor |
| `TWILIO_AUTH_TOKEN` | `.env` en servidor |
| `SSH_PRIVATE_KEY` | GitHub Actions Secrets |
| `SUPERADMIN_USER/PASS` | `.env` en servidor |

---

## 17. URLs de referencia rápida

| Recurso | URL |
|---|---|
| Super Admin producción | `https://netcarephone.com/superadmin` |
| Super Admin local | `http://localhost:3000/superadmin` |
| Credenciales SuperAdmin | `superadmin / SuperAdmin2024!` (o leer `.env`) |
| GitHub repo | `https://github.com/alextime67-max/netcare-receptionist` |
| GitHub Actions | `https://github.com/alextime67-max/netcare-receptionist/actions` |
| Health check | `https://netcarephone.com/` |
| Webhook MDcare (Realtime) | `https://netcarephone.com/webhook/mdcare/realtime-voice` |
| WebSocket Twilio | `wss://netcarephone.com/realtime/twilio/:slug` |
| WebSocket Live Voice | `wss://netcarephone.com/realtime/browser/:token` |
