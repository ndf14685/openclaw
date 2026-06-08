# Project Workflow Async Execution

Project Workflow long-running phases must not block the Telegram request/response cycle.
Telegram delivery is a user experience path; Architect, Implementer, and Reviewer execution are job paths with their own timeouts and recovery rules.

## Gateway Worker

Project Workflow now runs through an internal gateway worker after startup sidecars are ready. The worker is connected as a gateway lifetime sidecar and stops during normal gateway shutdown.

Defaults:

- `pollIntervalMs`: 5000
- `architect.timeoutMs`: 300000
- `implementer.timeoutMs`: 1800000
- `reviewer.timeoutMs`: 300000
- `architectureReviewer.timeoutMs`: 300000

The worker calls `processProjectWorkflowQueue(...)` on each tick. It skips overlapping ticks and claims each queued phase by writing the corresponding `*_running` state before executing external tools. Notification payloads are sent back to the persisted Telegram route using durable message delivery.

## Phase Async 1: Architect

In the first async phase, only Architect execution is moved out of the Telegram handler.

When a project topic receives a new goal, OpenClaw now:

1. creates and persists a ProjectWorkflow record;
2. sets status to `architect_queued`;
3. records audit entries for `draft_goal` and `architect_queued`;
4. replies immediately to Telegram:

```text
[Workflow]
workflow_id=...
phase=architect_queued
project=<projectId>

Recibi el pedido. El Architect esta analizando.
Te aviso cuando tenga una propuesta para aprobar.
```

The Telegram response no longer waits for Claude Architect.

## Worker

The exported worker entrypoint is:

```ts
processProjectWorkflowQueue(cfg, opts);
```

For Phase Async 1, the worker processes `architect_queued` workflows only:

```text
architect_queued
  -> architect_running
  -> awaiting_human_approval
```

If Architect fails or times out:

```text
architect_queued
  -> architect_running
  -> architect_failed
```

The worker is exported, covered by tests, and wired to gateway startup with a single internal poller. Telegram receives the initial acknowledgement immediately; the worker later notifies the same topic with the Architect proposal or an explicit error.

## Timeout Model

The Architect job timeout is separate from the Telegram UX timeout.

- Telegram response: should be immediate.
- Architect job: defaults to 300000 ms.
- Optional env override: `CLAUDE_ARCHITECT_TIMEOUT_MS`.

OAuth remains the authentication model for Claude. Do not use API keys or `ANTHROPIC_API_KEY` for Project Workflow Architect.

Timeout errors are persisted and surfaced as explicit ProjectWorkflow messages:

```text
Project Workflow Architect timeout after 300 seconds.
```

## Recovery And Idempotence

The worker claims a queued workflow by persisting `architect_running` before invoking Claude. It writes the Architect result only if the workflow still has the expected running state.

This prevents duplicate completion if two worker passes observe the store around the same time. Gateway integration includes stale-running recovery for workflows left in `architect_running`, `implementer_running`, `reviewer_running`, or `architecture_review_running` after a process crash. The first recovery policy is conservative: stale running phases are failed or blocked with an explicit reason; the worker does not automatically re-run them.

## Async Implementation And Review

Approval no longer runs Codex inline. When the operator sends `aprobar`, OpenClaw persists:

```text
awaiting_human_approval
  -> implementation_queued
```

and replies immediately:

```text
[Workflow]
workflow_id=...
phase=implementation_queued
project=<projectId>

Workflow aprobado. Implementer en ejecucion.
```

The worker then advances the remaining phases:

```text
implementation_queued
  -> implementer_running
  -> review_queued | blocked

review_queued
  -> reviewer_running
  -> review_passed | review_failed | blocked

architecture_review_queued
  -> architecture_review_running
  -> architecture_review_passed | architecture_review_failed | blocked
```

Architecture review is queued only when configured. In `review.mode: required`, a technical review FAIL prevents the architecture reviewer from running and the workflow ends as `review_failed`. In `review.mode: advisory`, reviewers still run and failures are recorded as warnings when possible.

Review policy remains supported:

- `review.mode: required` blocks completion on required review failure.
- `review.mode: advisory` records failures and completes as `completed_with_warnings` when appropriate.

## Configuration

Project Workflow remains OAuth-first for Claude. Do not configure API keys or `ANTHROPIC_API_KEY` for this path.

Optional future-facing configuration is accepted under:

```yaml
project_workflows:
  asyncExecution:
    enabled: true
    pollIntervalMs: 5000
    architect:
      timeoutMs: 300000
      staleMs: 300000
    implementer:
      timeoutMs: 1800000
    reviewer:
      timeoutMs: 300000
    architectureReviewer:
      timeoutMs: 300000
```

Deployment remains manual unless explicitly requested. Commit/push can be automated after tests, build, and checks pass.
