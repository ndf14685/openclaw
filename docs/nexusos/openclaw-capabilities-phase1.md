# OpenClaw Capabilities Phase 1

## Objetivo

Fase 1 agrega soporte minimo para seleccionar modelos por capability sin cambiar el comportamiento existente de OpenClaw.

La capability no es una migracion de configuracion ni un nuevo flujo obligatorio. Es una capa opcional, reversible y no disruptiva que solo participa en la resolucion de modelo cuando la configuracion opt-in `capabilities_enabled` esta explicitamente en `true`.

## Alcance arquitectonico

Esta implementacion debe tratarse como la capa adapter/implementation de OpenClaw para un contrato NexusOS, no como una feature aislada ni propietaria de OpenClaw.

En Fase 1, OpenClaw solo consume bindings locales ya resueltos en config. No descubre capabilities desde NexusOS/Backstage, no valida contra un catalogo NexusOS y no introduce dependencia directa con Backstage como producto.

La frontera esperada es:

- NexusOS define el contrato de capabilities y catalogo.
- OpenClaw implementa un adapter de ejecucion que puede leer una capability ya resuelta.
- Backstage, si se usa, debe ser una fuente posible de metadata/catalogo, no el contrato al que OpenClaw queda acoplado.

## Garantias de compatibilidad

- `capabilities_enabled` ausente equivale a `false`.
- `capabilities_enabled: false` equivale a no-op para cualquier capability.
- `payload.model` gana siempre sobre capability.
- `session.modelOverride` gana sobre capability.
- No hay migracion de sesiones actuales.
- No hay migracion de crons actuales.
- No hay cambio de providers configurados.
- No hay reload ni restart de gateway.
- La configuracion existente sigue funcionando sin agregar claves nuevas.

## Contrato inicial

La configuracion inicial expone bindings locales bajo:

```json
{
  "capabilities_enabled": true,
  "capabilities": {
    "bindings": {
      "research": "google/gemini-2.5-pro",
      "implementation": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      }
    }
  }
}
```

`capabilities.bindings.<name>` puede ser:

- string `"provider/model"`
- objeto `{ "provider": "...", "model": "..." }`

Si el objeto incluye `provider` y `model` no contiene `/`, OpenClaw compone el modelo efectivo como `provider/model`. Si el binding es invalido, esta vacio, no existe, o `capabilities_enabled !== true`, se ignora y se continua con la resolucion existente.

## Orden de resolucion de modelo

El orden efectivo queda:

1. `payload.model`
2. `session.modelOverride`
3. capability binding, solo si `capabilities_enabled === true`
4. default existente

Dentro del paso de capability binding, Fase 1 puede recibir la capability desde `payload.capability` o desde `session.capabilityOverride`. `payload.capability` se evalua primero; si no resuelve a un binding valido, se prueba `session.capabilityOverride`. En todos los casos, capability queda por debajo de `payload.model` y `session.modelOverride`.

## Archivos modificados

- `src/agents/tools/cron-tool.schema.test.ts`
- `src/agents/tools/cron-tool.ts`
- `src/config/sessions/types.ts`
- `src/config/types.openclaw.ts`
- `src/config/zod-schema.ts`
- `src/cron/isolated-agent.model-formatting.test.ts`
- `src/cron/isolated-agent/model-selection.ts`
- `src/cron/normalize.test.ts`
- `src/cron/normalize.ts`
- `src/cron/types.ts`
- `src/gateway/protocol/schema/cron.ts`
- `src/plugins/session-entry-slot-keys.ts`
- `docs/nexusos/openclaw-capabilities-phase1.md`

## Tests ejecutados

- 4 shards pasaron.
- 128 tests efectivos pasaron.
- `pnpm tsgo:core` paso.

## Fase 1.5: validacion controlada

Fase 1.5 valida el resolver con una config de ejemplo, sin activar capabilities en la config real, sin tocar Telegram, sin callbacks, sin milestones y sin reiniciar gateway.

Fixture:

- `docs/examples/openclaw.capabilities.sample.json`

Bindings esperados:

- `architect` -> `claude-cli/claude-sonnet-4-6`
- `implementer` -> `codex-cli/gpt-5.5`
- `reviewer` -> `claude-cli/claude-sonnet-4-6`

Comando dry-run:

```bash
pnpm openclaw capability resolver dry-run \
  --config docs/examples/openclaw.capabilities.sample.json \
  --capability architect
```

Salida de ejemplo:

```text
capability resolver dry-run
input capability: architect
binding resolved: claude-cli/claude-sonnet-4-6
provider/model final: claude-cli/claude-sonnet-4-6
fallback applied: no
reason: binding de capability resuelto porque capabilities_enabled === true
```

Salida JSON:

```bash
pnpm openclaw capability resolver dry-run \
  --config docs/examples/openclaw.capabilities.sample.json \
  --capability implementer \
  --json
```

El dry-run muestra:

- input capability
- binding resuelto
- provider/model final
- fallback aplicado o no
- motivo de resolucion

El comando solo lee el archivo indicado por `--config` y usa el catalogo de modelos en modo read-only. No ejecuta modelos, no abre Gateway, no escribe config, no modifica sesiones y no toca Telegram.

## Riesgos conocidos

- Todavia no hay discovery desde Backstage.
- Todavia no hay validacion contra catalogo NexusOS.
- Todavia no hay UI.
- Todavia no hay migracion.
- Todavia no hay gobernanza avanzada.
- Todavia no hay definicion final de como OpenClaw consumira capabilities externas sin acoplarse al producto Backstage.

## Criterio para Fase 2

Fase 2 solo puede avanzar si:

- Fase 1 esta documentada.
- Hay commit limpio.
- Se valida que gateway sigue funcionando.
- Se define como OpenClaw va a leer capabilities desde NexusOS/Backstage sin acoplarse a Backstage como producto.

Fase 2 no debe avanzar como parte de este cierre.
