# PROJECT_CONTEXT.md — openclaw

## Qué es este proyecto

Fork del proyecto open source OpenClaw ("Personal AI Assistant"), el gateway
que corre localmente y es la interfaz principal de Telegram para el usuario.
Coordina Codex, Claude y Gemini (agy) como agentes delegados según la
política de ruteo.

## Estado actual

- Repo: fork `git@github.com:ndf14685/openclaw.git` (remote `fork`),
  upstream real en `https://github.com/openclaw/openclaw.git` (remote
  `origin`).
- Rama actual de trabajo: `codex/telegram-agent-response-prefix` (no es
  `main`) — confirmar con el humano si este context pack debe ir también en
  `main` o si conviene esperar a que esta rama se integre.
- Servicio en producción: `openclaw-gateway.service` (systemd user mode),
  puerto `18789`, auth por token.
- Instalado bajo `/home/ndf/openclaw`; runtime state y config principal en
  `/home/ndf/.openclaw/` (separado del código).

## Cómo se escribe en este repo

- No se determinó en esta sesión si el proceso real es push directo o vía
  PR contra upstream — el fork tiene tanto `fork` (propio) como `origin`
  (upstream real). Confirmar antes de push a `main`.
- Cambios al gateway en producción requieren reiniciar
  `openclaw-gateway.service` — afecta Telegram en vivo.

## Dependencias con otros proyectos

- `idp-platform/scripts/nexusos/openclaw_nexusos_bridge.py` es el único path
  gobernado para side-effects invocados desde OpenClaw.
- `nexus-governor` (plugin instalado con `openclaw plugins install --link`)
  bloquea escrituras directas y fuerza todo por el bridge NexusOS.
- `jarvis-openclaw-desktop` consume este gateway vía HTTP
  (`/v1/chat/completions`) desde el cliente de escritorio Windows.

## Qué NO tocar sin confirmar con el humano

- `openclaw-gateway.service` en producción — está sirviendo Telegram en
  vivo. Reiniciar sin avisar corta el canal principal del usuario.
- `~/.openclaw/openclaw.json` (topic bindings, bot token, system prompts).

## Próximos pasos conocidos

- **OC-01 cerrado (2026-07-02)**: `Architecture.md` en la raíz de este repo
  - 10 issues de tracking en `ndf14685/openclaw#1-10` (issues del fork
    habilitados para esto, estaban deshabilitados por default). Hallazgo
    crítico: el servicio en producción corre desde un paquete npm global
    (2026.6.1), no desde este repo git (2026.5.6) — sin proceso de deploy
    documentado entre ambos. También: fork 21.100 commits detrás de
    upstream desde 2026-05-08, gateway expuesto en toda la LAN contra el
    trust model de upstream, runbook operativo desactualizado, backup de
    3.99GB sin cifrar en el working tree (no trackeado por git).
- OC-05: hecho en `idp-platform`, no en este repo (SAST/SCA/secret
  scanning ya vive en `idp-platform/.github/workflows/idp-security-gates.yml`).

## Historial de decisiones relevantes

- Todos los topics de Telegram están pineados a Codex desde 2026-05-30;
  Claude es delegate subagent, no entry point directo (ver
  `~/.openclaw/workspace/docs/AGENT_HANDOFF.md`).
- Ya existe `~/.openclaw/workspace/docs/OPENCLAW_INFRA_ARCHITECTURE.md` — la
  auditoría OC-01 debería referenciarlo/actualizarlo, no reemplazarlo a
  ciegas.
