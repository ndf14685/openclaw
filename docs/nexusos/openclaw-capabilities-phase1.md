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

## Ajuste de diseno: capabilities extensibles

OpenClaw no debe modelar una jaula de capabilities permitidas por topico, proyecto o canal. En particular, no debe introducir `allowed_capabilities` como lista cerrada que bloquee capacidades nuevas por proyecto.

Las capabilities son funcionales, dinamicas y emergentes. Un topico/proyecto puede aportar contexto de resolucion, pero no debe limitar el crecimiento del catalogo.

Un topico/proyecto puede tener:

- contexto operacional o semantico
- `default_capability` opcional
- provider binding overrides opcionales

Un topico/proyecto no debe tener:

- una lista cerrada de capabilities permitidas
- una restriccion que impida proponer capabilities nuevas
- activacion silenciosa de capabilities inexistentes

La resolucion conceptual de capability debe considerar, en orden:

1. capability explicita
2. intencion inferida
3. propuesta del architect
4. default del topico/proyecto
5. default global

Si una capability solicitada, inferida o propuesta no existe, OpenClaw debe crear una propuesta en estado `draft` o `proposed`, no registrarla ni activarla automaticamente.

La propuesta debe documentar:

- `capability`
- `purpose`
- `inputs`
- `outputs`
- `restrictions`
- `suggested_provider_binding`
- `risks`
- `status`

Ejemplo:

```json
{
  "capability": "release-manager",
  "purpose": "preparar releases, changelog, versionado y rollback",
  "inputs": ["commits", "pull requests", "version policy", "release notes"],
  "outputs": ["release plan", "changelog draft", "rollback plan"],
  "restrictions": ["no publicar releases sin aprobacion humana"],
  "suggested_provider_binding": "claude-cli",
  "risks": ["versionado incorrecto", "omitir cambios relevantes", "publicacion prematura"],
  "status": "proposed"
}
```

Separacion obligatoria de superficies:

- topic/project context
- default capability
- capability catalog
- provider bindings
- capability proposals

El catalogo de capabilities debe poder crecer con cada proyecto mediante propuestas gobernadas por aprobacion humana.

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
- Todavia no hay mecanismo persistente de `capability proposals`.
- Todavia no hay resolucion por intencion inferida ni propuesta del architect.

## Criterio para Fase 2

Fase 2 solo puede avanzar si:

- Fase 1 esta documentada.
- Hay commit limpio.
- Se valida que gateway sigue funcionando.
- Se define como OpenClaw va a leer capabilities desde NexusOS/Backstage sin acoplarse a Backstage como producto.
- Se define el almacenamiento de topic/project context, default capability, capability catalog, provider bindings y capability proposals como superficies separadas.
- Se preserva explicitamente que no existe `allowed_capabilities` como restriccion cerrada por topico/proyecto.

Fase 2 no debe avanzar como parte de este cierre.
