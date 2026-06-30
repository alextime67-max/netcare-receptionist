# NetCare — Deployment Guide

## Flujo oficial de trabajo

```
Código local  →  git push origin master  →  GitHub Actions  →  Hetzner (auto)
```

Cada push a `master` dispara el deploy automático. No se toca el servidor manualmente.

---

## Arquitectura de producción

| Componente | Detalle |
|---|---|
| Servidor | Hetzner VPS — `5.161.59.190` |
| Dominio | `netcarephone.com` (HTTPS, SSL Let's Encrypt) |
| Proxy | nginx → `localhost:3000` |
| App | PM2 proceso `netcare-phone` → `src/server.js` |
| Base de datos | SQLite en `/root/netcare-receptionist/data/netcare.db` |
| Código | `/root/netcare-receptionist/` (rama `master`) |

---

## Cómo desarrollar desde casa o la oficina

1. **Clonar el repositorio** (primera vez):
   ```bash
   git clone https://github.com/alextime67-max/netcare-receptionist.git
   cd netcare-receptionist
   npm install
   cp .env.example .env   # editar con tus claves
   ```

2. **Correr en local:**
   ```bash
   npm run dev   # nodemon — recarga automática al guardar
   ```
   Panel admin local: `http://localhost:3000/superadmin`

3. **Mantener tu rama actualizada** antes de trabajar:
   ```bash
   git pull origin master
   ```

---

## Cómo hacer commit y push (deploy)

```bash
# 1. Revisar qué cambió
git status
git diff

# 2. Agregar solo los archivos que modificaste
git add src/services/realtime.js src/public/superadmin.html

# 3. Commit con mensaje claro
git commit -m "Fix: descripción concisa del cambio"

# 4. Push — esto dispara el deploy automático
git push origin master
```

> **Regla:** Solo haz push a `master` cuando el cambio esté probado localmente y aprobado.

---

## Cómo verificar que el deploy terminó

### Opción 1 — GitHub Actions (navegador)
1. Ir a `https://github.com/alextime67-max/netcare-receptionist/actions`
2. El workflow más reciente debe mostrar ✅ verde.
3. Si muestra ❌ rojo, el deploy falló y el rollback automático se ejecutó.

### Opción 2 — SSH directo
```bash
ssh root@5.161.59.190 "cd /root/netcare-receptionist && git log --oneline -3"
```
El commit más reciente debe coincidir con tu último push.

### Opción 3 — Health check
```bash
curl -s -o /dev/null -w "%{http_code}" https://netcarephone.com/
# debe responder: 200
```

---

## Cómo revisar logs de PM2

```bash
ssh root@5.161.59.190

# Ver logs en tiempo real
pm2 logs netcare-phone

# Ver últimas 50 líneas (sin streaming)
pm2 logs netcare-phone --lines 50 --nostream

# Ver solo errores
pm2 logs netcare-phone --err --lines 30 --nostream

# Estado del proceso
pm2 list
```

Logs guardados en el servidor en:
- `~/.pm2/logs/netcare-phone-out.log` — stdout
- `~/.pm2/logs/netcare-phone-error.log` — stderr

---

## Cómo hacer rollback si algo falla

### Rollback automático (integrado en el workflow)
El workflow hace health check después del deploy. Si el servidor no responde en 30 segundos, revierte automáticamente al commit anterior y reinicia PM2.

### Rollback manual (si el automático no alcanzó)

```bash
ssh root@5.161.59.190
cd /root/netcare-receptionist

# Ver historial de commits
git log --oneline -10

# Revertir al commit anterior (reemplaza HASH con el commit bueno)
git reset --hard HASH
npm install --production
pm2 restart netcare-phone
pm2 save

# Verificar que el app responde
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```

### Rollback desde GitHub (alternativa)
Si quieres un commit de rollback limpio en el historial:
```bash
git revert HEAD        # crea un commit que deshace el último cambio
git push origin master # dispara un nuevo deploy con el revert
```

---

## Qué nunca debes editar directamente en el servidor

| Nunca editar | Por qué |
|---|---|
| Archivos de código en `/root/netcare-receptionist/src/` | El próximo `git pull` los sobreescribe y pierdes los cambios |
| `package.json` o `package-lock.json` en el servidor | Igual, se sobreescriben con el pull |
| La base de datos `data/netcare.db` con comandos SQL directos | Sin respaldo, sin historial, sin validación |
| `.env` del servidor sin respaldo | Si el deploy lo pisa, pierdes las claves de producción |
| Nginx config sin documentar el cambio | El servidor puede dejar de funcionar sin forma de revertir |

**Regla general:** El servidor es de solo-lectura para código. Todo cambio de código va por Git.

---

## Secretos y variables de entorno

Los secretos de producción viven en dos lugares:

1. **GitHub Actions secret** (`SSH_PRIVATE_KEY`) — solo para el deploy SSH. Se configura en:
   `https://github.com/alextime67-max/netcare-receptionist/settings/secrets/actions`

2. **`.env` en el servidor** (`/root/netcare-receptionist/.env`) — variables de runtime (OpenAI, Twilio, etc.). Este archivo NO está en Git. Editarlo directamente en el servidor es la excepción permitida (siempre con respaldo previo).

---

## Infraestructura de producción (referencia rápida)

```
Internet → netcarephone.com:443
         → nginx (SSL termination)
         → localhost:3000 (Node.js / Express)
         → PM2 proceso netcare-phone
         → src/server.js

WebSocket paths:
  wss://netcarephone.com/realtime/twilio/:slug   → Twilio Media Streams
  wss://netcarephone.com/realtime/browser/:token → Live Voice (SuperAdmin)

Webhooks Twilio:
  POST /webhook/:slug/realtime-voice  → OpenAI Realtime (activo)
  POST /webhook/:slug/voice           → Legacy IVR (Polly)
```

---

## Checklist antes de hacer push a master

- [ ] El cambio funciona en `localhost:3000`
- [ ] Live Voice sigue funcionando (si tocaste `realtime.js`)
- [ ] No hay `console.log` con claves o datos sensibles
- [ ] El commit message es descriptivo
- [ ] Solo stagueaste los archivos que realmente cambiaste (`git status` limpio)
