# NetCare Phone AI — Instrucciones del proyecto

## Comando deploy

Cuando el usuario escriba únicamente `deploy`, ejecutar automáticamente el flujo completo definido en `.claude/skills/deploy.md`. No pedir confirmación. Ejecutar todas las fases en orden.

## Contexto del proyecto

- **Producto:** NetCare AI Medical Receptionist — recepcionista bilingual (ES/EN) con voz IA.
- **Stack:** Node.js + Express + SQLite (better-sqlite3) + OpenAI Realtime API + Twilio Media Streams.
- **Producción:** Hetzner VPS `5.161.59.190` → `netcarephone.com`
- **Process manager:** PM2, proceso `netcare-phone`, script `src/server.js`
- **Deploy:** GitHub Actions auto-deploy en push a `master` (`.github/workflows/deploy.yml`)

## Reglas permanentes de seguridad

- NUNCA sobrescribir la base de datos de producción sin aprobación explícita.
- NUNCA borrar datos reales (call logs, KB de clientes, AI configs existentes).
- NUNCA hacer commit hasta que el usuario pruebe y apruebe un cambio de funcionalidad.
- NUNCA cambiar modelo OpenAI, voz, ni Knowledge Base sin instrucción explícita.
- NUNCA exponer claves (OpenAI, Twilio, SSH) en logs, commits ni respuestas.

## Arquitectura WebSocket

- `/realtime/twilio/:slug` → Twilio Media Streams (G.711 μ-law)
- `/realtime/browser/:token` → Live Voice desde SuperAdmin

## Credenciales de acceso (NO guardar en código)

- SuperAdmin local: `superadmin / SuperAdmin2024!`
- SuperAdmin prod: igual (leer de `.env` en servidor)
- SSH prod: `root@5.161.59.190`

## Camelcase ↔ snake_case

La API del SuperAdmin acepta camelCase. La DB usa snake_case. El mapeo está en `src/database/db.js` → `updateClinicAiConfig` y `updateClinic`.
