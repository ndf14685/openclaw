# ADR-0001: Capability Governance and Intent Resolution

- Status: Proposed
- Date: 2026-06-05

## Context

OpenClaw is adding an optional capability-based routing layer. Phase 1 only added local capability bindings behind `capabilities_enabled === true`, preserving all existing behavior when the flag is absent or false.

The next design step must avoid turning capabilities into a closed per-topic or per-project allowlist. Projects evolve, and agents may discover functional needs that were not known when the topic/project was created.

The architecture needs a governed way to let the capability catalog grow without silently activating new behavior.

## Decision

OpenClaw capabilities are functional, dynamic, and emergent. They are not modeled as a closed list of capabilities allowed by a topic, project, or channel.

Topic/project configuration may provide:

- context
- optional `default_capability`
- optional provider binding overrides

Topic/project configuration must not provide:

- `allowed_capabilities` as a closed restriction
- any equivalent per-topic capability jail
- silent activation of unknown capabilities

Capability resolution should use this conceptual order:

1. explicit capability
2. inferred intent
3. pending capability proposal
4. topic/project default capability
5. global default capability

If a requested or inferred capability does not exist in the approved capability catalog, OpenClaw must not register or activate it automatically. It must create or surface a capability proposal in `draft` or `proposed` state and wait for human approval before it can become active.

## Capability Proposals

A capability proposal is the governance object for catalog growth. It should include:

- `capability`
- `purpose`
- `inputs`
- `outputs`
- `restrictions`
- `suggested_provider_binding`
- `risks`
- `status`

Example:

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

Pending proposals are visible to the resolver as governance state, but they are not executable capabilities. A pending proposal can explain why OpenClaw is pausing for approval, suggest a provider binding, and document the intended contract. It cannot route execution until approved.

## Separation of Surfaces

The capability architecture must keep these surfaces separate:

- topic/project context
- default capability
- capability catalog
- provider bindings
- capability proposals

This separation keeps topic context from becoming policy, keeps provider binding from becoming capability definition, and keeps proposals from becoming active capabilities without approval.

## Consequences

- OpenClaw can evolve capabilities with each project without predeclaring a closed set.
- Unknown capabilities become reviewable proposal artifacts instead of runtime surprises.
- The architect can propose new capabilities when it detects missing functionality.
- Human approval remains the boundary between proposed capability and active catalog entry.
- Fase 2 must define storage, approval, and read paths for proposals before connecting capability resolution to Telegram or other live channel flows.

## Non-Goals

- This ADR does not activate capability routing in the live config.
- This ADR does not migrate sessions or crons.
- This ADR does not define Backstage as a required product dependency.
- This ADR does not add Telegram behavior.
- This ADR does not implement the proposal approval UI.
