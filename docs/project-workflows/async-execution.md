# Project Workflow Async Execution

Project Workflow long-running phases must not block the Telegram request/response cycle.
Telegram delivery is a user experience path; Architect, Implementer, and Reviewer execution are job paths with their own timeouts and recovery rules.

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

The worker is exported and covered by tests, but it is not wired to a real gateway polling interval yet. A later phase should connect it to gateway startup with a single internal poller, for example every 5000 ms.

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

This prevents duplicate completion if two worker passes observe the store around the same time. A later gateway integration should add stale-running recovery for workflows left in `architect_running` after a process crash.

## Future Phases

Phase Async 1 intentionally does not change approval, implementation, or review execution.

Planned phases:

1. Implementer async after human approval.
2. Technical Reviewer async after Implementer completion.
3. Architecture Reviewer async when configured.
4. Gateway poller integration with restart recovery and stale job handling.

Review policy remains supported:

- `review.mode: required` blocks completion on required review failure.
- `review.mode: advisory` records failures and completes as `completed_with_warnings` when appropriate.
