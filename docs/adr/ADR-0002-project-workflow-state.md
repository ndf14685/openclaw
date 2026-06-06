# ADR-0002: Project Workflow State

- Status: Proposed
- Date: 2026-06-06

## Context

OpenClaw already supports channel topics, session bindings, agent routing, and
capability governance as separate concepts. Project work in a chat topic still
places too much operational burden on the human operator when the operator must
move context between architectural planning, implementation, and review agents.

For project topics, the desired operating model is:

1. The human defines a goal, approves or rejects proposals, and changes
   direction when needed.
2. OpenClaw selects the right capability for each workflow phase.
3. OpenClaw moves context between phases without requiring the human to copy
   and paste agent messages.
4. The final result returns to the originating chat topic.

The primary abstraction should therefore be a project workflow, not a manual
capability switch.

## Decision

Introduce `ProjectWorkflow` as the first-class conceptual entity for project
topic work.

A `ProjectWorkflow` represents one durable unit of project work owned by a
project and a channel route. It carries the goal, workflow status, approvals,
phase artifacts, capability invocations, and references to related sessions.

`ProjectWorkflow` does not replace the legacy topic, session, or agent routing
flow. It is an opt-in workflow layer that must remain behind a feature flag
until dry-run behavior, persistence, approvals, and compatibility are proven.

The central principle is:

> The user does not switch agents. The workflow changes phase.

Manual capability commands may exist for override, inspection, and debugging,
but the normal project flow must not depend on commands such as
`/capability architect`, `/capability implementer`, or `/capability reviewer`.

In the normal workflow surface, the human operator should only need to:

- define a goal;
- approve;
- reject;
- change direction;
- cancel;
- ask for status.

## Conceptual Shape

```json
{
  "workflow_id": "pwf_...",
  "project_id": "project-id",
  "route": {
    "channel": "telegram",
    "account_id": "default",
    "chat_id": "<chat-id>",
    "topic_id": "<topic-id>"
  },
  "goal": {
    "text": "operator supplied goal",
    "created_by": "<user-id>",
    "created_at": "2026-06-06T00:00:00.000Z"
  },
  "status": "awaiting_human_approval",
  "phase": "architect_proposal",
  "current_capability": "architect",
  "approvals": [],
  "artifacts": {
    "proposal": null,
    "implementation_summary": null,
    "review_summary": null
  },
  "sessions": {
    "canonical": null,
    "architect": null,
    "implementer": null,
    "reviewer": null
  },
  "audit_log": []
}
```

This shape is not a storage schema commitment. It defines the required product
concepts and the boundary between workflow state and session transcripts.

## States

The minimal workflow states are:

- `draft_goal`: OpenClaw received a candidate goal and is normalizing scope.
- `architect_running`: the architect capability is preparing a proposal.
- `awaiting_human_approval`: a proposal or sensitive next step needs a human
  decision.
- `approved_for_implementation`: the approved proposal is ready to hand off to
  implementation.
- `implementer_running`: the implementer capability is executing the approved
  work.
- `reviewer_running`: the reviewer capability is validating the implementation.
- `awaiting_fix_approval`: review found a follow-up change that requires a
  human decision.
- `blocked`: progress requires missing input, credentials, permission, or an
  external state change.
- `failed`: a technical failure stopped the workflow, with diagnostics attached.
- `rejected`: the human rejected the current proposal or direction.
- `cancelled`: the workflow was intentionally stopped.
- `completed`: review passed and the result was returned to the originating
  route.

## Transitions

The normal transition path is:

```text
draft_goal
  -> architect_running
  -> awaiting_human_approval
  -> approved_for_implementation
  -> implementer_running
  -> reviewer_running
  -> completed
```

Human transitions:

- `approve`: allowed from `awaiting_human_approval` and
  `awaiting_fix_approval`.
- `reject`: records a rejection and either closes the workflow or returns it to
  `architect_running` with a reason.
- `change_direction`: appends direction text and returns the workflow to
  `architect_running`.
- `cancel`: moves the workflow to `cancelled`.
- `status`: reads workflow state without changing it.

Internal transitions:

- Architect produces a proposal and moves the workflow to
  `awaiting_human_approval`.
- Approval records the exact proposal scope and moves the workflow to
  `approved_for_implementation`.
- Implementer receives an approved handoff packet and moves the workflow to
  `reviewer_running` when execution finishes.
- Reviewer compares implementation evidence against the approved scope and
  either completes the workflow or returns it to implementation or approval.

Invalid transitions must be rejected with a clear status response instead of
silently changing phase.

## Approvals

Approvals belong to the workflow, not to an agent session.

Each approval record should include:

- approver identity;
- timestamp;
- approved workflow id and phase;
- approved proposal or action digest;
- scope of authority;
- explicit restrictions;
- expiration when applicable;
- route where approval was received;
- optional reason or operator note.

Approval scope should distinguish routine implementation from sensitive actions
such as deploys, restarts, secret changes, database mutations, destructive
commands, public actions, or other irreversible operations.

The implementer must execute only inside the approved scope. If the implementer
discovers work outside that scope, the workflow returns to an approval state
instead of broadening the approval implicitly.

## Relationship With Capabilities

Capabilities are internal workflow roles. They are not the user's primary
control surface.

- `architect`: turns a goal into an approvable proposal, including scope,
  risks, required evidence, and sensitive actions.
- `implementer`: executes only the approved proposal and emits implementation
  evidence.
- `reviewer`: validates the evidence against the approved proposal and produces
  a pass, failure, or follow-up recommendation.
- `researcher`: optional support capability invoked by architect or reviewer
  when external or broad context is required.

Capability bindings remain replaceable. For example, `architect` may resolve to
one provider today and another provider later without changing project workflow
semantics.

Capability override commands may still exist for debugging and exceptional
operator control, but they must not be required in the happy path.

Capabilities are internal to the workflow engine. They are not the main command
surface for the user.

## Relationship With Telegram

Telegram topics are workflow routes and operator surfaces.

A project topic may provide project context, such as project id, repository,
namespace, or default workflow policy. When a goal is received in that topic,
OpenClaw may create or resume the active `ProjectWorkflow` for that route.

Telegram interactions should be small and mobile-friendly:

- define a goal in natural language;
- approve;
- reject;
- change direction;
- cancel;
- ask for status.

Workflow results, approval requests, blocked notices, and final summaries return
to the originating topic. Internal architect, implementer, reviewer, and
researcher handoffs must not require the operator to copy messages between
agents or topics.

## Relationship With Existing Sessions

Sessions remain transcript and execution context. `ProjectWorkflow` is the
source of truth for workflow state.

The workflow should reference sessions instead of embedding full transcripts:

- a canonical topic session for the human-facing conversation;
- optional phase sessions for architect, implementer, reviewer, and researcher;
- child-session or subagent references where the runtime creates them;
- compact handoff packets for phase changes.

Changing phase must not reset the topic session. Session compaction must not
erase the essential workflow state because approvals, current phase, artifacts,
and audit history live on the workflow entity.

Existing sessions and thread bindings should remain valid during migration.
If no workflow state exists for a topic, OpenClaw should preserve current
session behavior.

## Phase 0 Dry Run

Before any runtime integration, implement a dry-run-only validation path that
simulates a workflow for a selected Telegram project topic without executing
real agents, changing live Telegram behavior, modifying runtime config, or
restarting the Gateway.

The first runtime mode for `ProjectWorkflow` must be dry-run, no-agent, and
no-write. It may explain planned phases and selected capabilities, but it must
not call architect, implementer, reviewer, or researcher agents.

The first operator pilot topic is Telegram topic `2679`.

Dry-run inputs:

- channel: `telegram`;
- account id;
- chat id;
- topic id;
- project id;
- goal text;
- optional configured default workflow policy.

Dry-run output:

- resolved project route;
- created conceptual workflow id;
- state transition trace;
- selected capabilities per phase;
- simulated architect proposal;
- simulated approval gate;
- simulated implementer handoff packet;
- simulated reviewer handoff packet;
- final dry-run summary;
- warnings for missing config, unknown project metadata, or ambiguous routing.

The Phase 0 dry run must be read-only. It must not:

- call real architect, implementer, reviewer, or researcher agents;
- mutate live `openclaw.json`;
- mutate Telegram topic configuration;
- write production workflow state;
- create or modify sessions;
- create or modify crons;
- restart or reload the Gateway.

Successful Phase 0 acceptance means OpenClaw can explain what it would do for a
project topic goal before any real workflow engine is connected.

## Consequences

- Project work can become approval-driven instead of message-transport-driven.
- Capability governance remains decoupled from provider selection.
- Human approval becomes a durable workflow transition, not a conversational
  hint inside one agent transcript.
- Existing topic/session behavior can remain the compatibility baseline.
- Runtime implementation must add workflow storage, transition validation,
  approval binding, and dry-run reporting before live Telegram execution.

## Non-Goals

- This ADR does not implement workflow storage.
- This ADR does not change live Telegram behavior.
- This ADR does not modify runtime configuration.
- This ADR does not change provider bindings.
- This ADR does not restart, reload, or require the Gateway.
- This ADR does not migrate existing sessions, crons, or topic bindings.
