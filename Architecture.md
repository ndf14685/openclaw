# Architecture.md — openclaw (this fork/deployment)

Entregable OC-01 del sprint 2026-07-01/02. Audita cómo está desplegado y
configurado OpenClaw en este host (`rig3060`), no reescribe la arquitectura
interna del proyecto upstream (para eso, ver `docs/` y `SECURITY.md` de este
mismo repo, y `docs.openclaw.ai`). Complementa, no reemplaza, el runbook
operativo existente en
`~/.openclaw/workspace/docs/OPENCLAW_INFRA_ARCHITECTURE.md`.

## Qué es OpenClaw acá

Gateway local que actúa como "second brain" / interfaz de agentes para el
usuario, con Telegram como canal principal. Coordina tres agentes (Codex,
Claude, Gemini/"agy") según una política de ruteo. Ver
`PROJECT_CONTEXT.md` de este repo y
`~/.openclaw/workspace/docs/AGENT_HANDOFF.md` para la política de ruteo
vigente.

## Topología real (verificada en esta auditoría)

```
Telegram (@Nestor_DevOps_Bot)
  |
  v
openclaw-telegram-proxy.service  (127.0.0.1:18790, IP de Telegram pineada)
  |
  v
openclaw-gateway.service  (bind: lan, puerto 18789, http://192.168.50.105:18789/)
  |         auth: gateway.auth.token (48 chars)
  |
  +--> Codex / Claude / Gemini (agy) / Ollama (routing policy)
  +--> idp-platform/scripts/nexusos/openclaw_nexusos_bridge.py (via plugin nexus-governor)
  +--> jarvis-openclaw-desktop (cliente Windows, consume /v1/chat/completions)
```

## Hallazgo crítico: el código fuente de este repo NO es lo que corre en producción

`openclaw-gateway.service` (systemd user unit) ejecuta:

```
/home/ndf/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/dist/index.js
```

— un paquete npm instalado **globalmente**, versión `2026.6.1`, build del
2026-06-08. **No** es un symlink a este repo git (`/home/ndf/openclaw`).
Este repo git está en `2026.5.6`, build del 2026-06-06, en la rama
`codex/telegram-agent-response-prefix` (no `main`).

Esto significa: cualquier cambio hecho en este repo (incluidos los 10
commits propios listados abajo) **no se refleja automáticamente** en el
servicio real hasta que exista un paso de deploy explícito, y ese paso no
está documentado en ningún lado que se haya encontrado en esta auditoría.
`OPENCLAW_INFRA_ARCHITECTURE.md` (el runbook operativo) describe
incorrectamente el `ExecStart` como si apuntara a este repo — está
desactualizado en ese punto específico.

También existe una tercera copia sin uso claro:
`~/.nvm/.../node_modules/openclaw.backup-before-projectworkflow-20260606-0331`
(snapshot de un deploy anterior).

## Divergencia con upstream

- Este fork tiene **10 commits propios** sobre upstream (todos de Nestor
  Fleitas): capability resolver dry run, opt-in capability model bindings,
  métricas Prometheus, política de ruteo colaborativo de Telegram, prefijos
  de respuesta de agente Telegram, y sus ADRs asociados.
- El punto de divergencia (`merge-base`) con `origin/main` es del
  **2026-05-08**. Desde entonces, upstream avanzó **~21.100 commits**. Esta
  rama nunca se rebaseó ni actualizó contra upstream desde esa fecha.
- Consecuencia práctica: parches de seguridad, fixes de bugs y features
  nuevas de upstream desde esa fecha no están en este repo. Un rebase
  directo de 21k commits es de alto riesgo de conflictos; la alternativa más
  segura es evaluar cherry-pickear los 10 commits propios sobre un checkout
  limpio y actual de upstream.

## Trust model (definido por upstream, aplica acá)

De `SECURITY.md`: _"OpenClaw is local-first agent infrastructure for
trusted operators; it is not designed as a shared multi-tenant boundary
between adversarial users on one gateway."_ — es decir, upstream asume que
cualquiera con acceso de red al gateway es un operador confiable, no un
adversario. Esta deployment expone el gateway en `bind: lan`
(`192.168.50.105:18789`, toda la LAN doméstica), protegido solo por un
token, no por aislamiento de red adicional (VPN/firewall por IP). Si algún
dispositivo no confiable comparte esa LAN, queda dentro del perímetro que
upstream explícitamente dice no defender.

## Superficie de plugins/extensiones

132 extensiones bundled (proveedores de modelo, canales, etc.) instaladas
vía `postinstall: node scripts/postinstall-bundled-plugins.mjs` — ejecuta
código en cada `npm install`. Es el patrón estándar del proyecto, no algo
introducido por este fork; se documenta como superficie de supply-chain a
tener presente, no como algo para "arreglar" acá.

El plugin `nexus-governor` (instalado vía `openclaw plugins install
--link` desde `idp-platform/scripts/nexusos/openclaw-plugin-nexus-governor/`)
es la única extensión custom relevante para gobernanza: fuerza todo
side-effect a pasar por el bridge NexusOS. Ver
`idp-platform/PROJECT_CONTEXT.md`.

## Top 10 riesgos

1. **[CRÍTICO] Deriva código-fuente vs. runtime**: el servicio en
   producción corre desde un paquete npm global (2026.6.1) no verificado
   como derivado de este repo (2026.5.6, rama no-main). No hay proceso de
   deploy documentado ni verificado. Ver sección arriba.
2. **[ALTO] Fork 21.100 commits detrás de upstream** desde 2026-05-08 —
   parches de seguridad y fixes de upstream ausentes; alto riesgo de
   conflicto si se intenta un rebase directo tan tarde.
3. **[ALTO] Gateway expuesto en toda la LAN** (`bind: lan`) contradiciendo
   el trust model explícito de upstream ("trusted operators", no
   multi-tenant/adversarial), protegido solo por un token sin aislamiento
   de red adicional.
4. **[ALTO] Token OAuth `openai/gpt-5.5` del fallback embebido vencido**
   (hallado en el spike JV-01 del 2026-07-01): tareas lentas de Codex vía
   gateway (>120s) caen a un fallback que falla con
   `refresh token was already used`, en vez de responder. Ver
   `~/.openclaw/workspace/docs/KNOWN_ERRORS.md`.
5. **[MEDIO] Runbook operativo desactualizado**:
   `OPENCLAW_INFRA_ARCHITECTURE.md` describe un `ExecStart` que no coincide
   con la configuración real del systemd unit — cualquier troubleshooting
   basado en ese documento parte de una premisa incorrecta.
6. **[MEDIO] Backup de 3.99 GB sin cifrar en el working directory del repo**
   (`2026-05-19T20-18-51.012Z-openclaw-backup.tar.gz`). No está trackeado
   por git (confirmado, no hay leak de historia), pero es un archivo grande
   con nombre "backup" sentado sin protección visible en el filesystem.
7. **[MEDIO] Tres copias del código sin relación explícita**: el repo git,
   el paquete npm global activo, y un backup de instalación previa
   (`openclaw.backup-before-projectworkflow-20260606-0331`). Sin un
   inventario claro de cuál es la fuente de verdad.
8. **[MEDIO] Rama de trabajo activa no es `main`**: todo el desarrollo
   propio vive en `codex/telegram-agent-response-prefix`, nunca mergeada a
   `main` local. Si se pierde esa rama, se pierde el trabajo custom.
9. **[BAJO] Working tree con archivos grandes fuera de `.gitignore`
   patterns conocidos** (el backup de 4GB) — vale la pena confirmar que no
   hay más archivos de este tipo acumulándose sin control en el filesystem
   del host.
10. **[BAJO] Superficie de 132 extensiones bundled con `postinstall`
    ejecutando código en cada install** — riesgo de supply-chain inherente
    al proyecto upstream, no introducido por este fork, pero vale la pena
    que quede documentado como superficie conocida.

## Qué NO se auditó en esta pasada

El código fuente completo de upstream (miles de archivos, proyecto OSS
activo con su propio proceso de seguridad — ver `SECURITY.md`,
`.semgrepignore`, `.pre-commit-config.yaml`, `security/opengrep/` ya
presentes). Auditar línea por línea el código de upstream está fuera de
alcance y de valor marginal frente a auditar la configuración/deployment
específico de este host, que es lo que se hizo acá.
