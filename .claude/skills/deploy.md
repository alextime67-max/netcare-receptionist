# deploy

Flujo completo de publicación de NetCare Phone AI.

## Cuándo usar

El usuario escribe únicamente `deploy`. Ejecutar todas las fases en orden sin pedir confirmación salvo error crítico.

## Reglas de seguridad (siempre activas)

- NUNCA sobrescribir la base de datos de producción.
- NUNCA borrar datos reales.
- NUNCA publicar si hay errores críticos sin resolver.
- Si cualquier fase falla → detener y explicar el motivo exacto antes de continuar.

---

## Fase 1 — Validación

```bash
node -e "require('./src/server.js')" 2>&1 | head -5   # syntax check server
node -e "require('./src/services/realtime.js')"        # syntax check realtime
node -e "require('./src/database/db.js')"              # syntax check db
```

- Si alguno lanza error de sintaxis → corregir antes de continuar.
- Verificar git status para saber qué archivos cambiaron.
- Si working tree está limpio (nothing to commit) → saltar Fase 2 e ir directo a Fase 4.

## Fase 2 — Git

```bash
git status
git diff --stat
# Stagear solo archivos modificados relevantes (nunca .env, nunca data/)
git add <archivos>
git commit -m "<mensaje descriptivo del cambio>"
git push origin master
```

- El mensaje de commit debe describir el cambio real (no "deploy").
- Agregar siempre `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` al final del commit.

## Fase 3 — GitHub Actions

- Esperar ~60 segundos y luego verificar que Hetzner tiene el nuevo commit:
  ```bash
  ssh root@5.161.59.190 "cd /root/netcare-receptionist && git log --oneline -1"
  ```
- Si el commit no llegó en 90 s → reportar fallo de GitHub Actions.

## Fase 4 — Producción

```bash
ssh root@5.161.59.190 "
  cd /root/netcare-receptionist &&
  git log --oneline -1 &&
  pm2 list --no-color | grep netcare &&
  curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:3000/
"
```

Verificar:
- Commit == último push ✅
- PM2 `netcare-phone` status: `online` ✅
- Health check: `HTTP 200` ✅

También verificar SuperAdmin accesible:
```bash
curl -s -o /dev/null -w "%{http_code}" -u superadmin:SuperAdmin2024! https://netcarephone.com/superadmin
```
Debe responder `200`.

## Fase 5 — IA (Live Voice + Twilio)

Obtener token y conectar WebSocket a Live Voice:
```bash
TOKEN=$(curl -s -X POST -u superadmin:SuperAdmin2024! \
  https://netcarephone.com/superadmin/api/clinics/2/realtime/session \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).ws_token));")

node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://netcarephone.com/realtime/browser/$TOKEN');
const t = setTimeout(()=>{ console.log('TIMEOUT'); ws.close(); }, 20000);
ws.on('message', raw => {
  const e = JSON.parse(raw);
  if (e.type === 'session.created') console.log('[OK] session.created model:', e.session?.model);
  if (e.type === 'session.updated') console.log('[OK] instructions:', (e.session?.instructions||'').length, 'chars');
  if (e.type === 'response.done') {
    const t2 = e.response?.output?.[0]?.content?.[0]?.transcript || '';
    console.log('[Ana greeting]:', t2);
    clearTimeout(t); ws.close();
  }
  if (e.type === 'error') { console.log('[ERROR]', JSON.stringify(e.error)); clearTimeout(t); ws.close(); }
});
ws.on('error', e => console.log('[WS ERROR]', e.message));
"
```

Verificar en los logs de PM2 que no hay errores nuevos:
```bash
ssh root@5.161.59.190 "pm2 logs netcare-phone --lines 20 --nostream 2>&1 | tail -20"
```

## Fase 6 — Seguridad

Revisar que los logs de PM2 no contengan:
- `No OpenAI API key`
- `Invalid or expired token` (en contexto de error, no de uso normal)
- `ECONNREFUSED`
- Stack traces no esperados

---

## Reporte final

Mostrar siempre este bloque al terminar:

```
========================================
✅ DEPLOY COMPLETADO

Commit:          <hash corto> — <mensaje>
GitHub:          https://github.com/alextime67-max/netcare-receptionist/commits/master
GitHub Actions:  ✅ Desplegado correctamente
Servidor Hetzner: <hash> en /root/netcare-receptionist
PM2:             netcare-phone — online
Health Check:    HTTP 200
SuperAdmin:      https://netcarephone.com/superadmin — 200 OK
Live Voice:      ✅ session.created / Ana respondió
Twilio:          ✅ (último log de llamada o sin errores nuevos)
Estado Final:    ✅ Producción actualizada correctamente.

✅ Producción actualizada correctamente.
========================================
```

Si alguna fase falla, reemplazar ✅ por ❌ en esa línea y explicar el error debajo del bloque.
