import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  handleProjectWorkflowReply,
  processProjectWorkflowQueue,
  recoverStaleProjectWorkflows,
} from "./runtime.js";
import { readProjectWorkflowStore, updateProjectWorkflowStore } from "./store.js";
import { resetProjectWorkflowWorkerForTest, startProjectWorkflowWorker } from "./worker.js";

const cfg = {
  project_workflows_enabled: true,
  project_workflows: {
    pilots: [
      {
        channel: "telegram",
        accountId: "default",
        chatId: "-1003958513253",
        topicId: "2679",
        projectId: "idp-platform",
      },
    ],
    projects: {
      "idp-platform": {
        repoPath: "/home/ndf/idp-platform",
        worktreeRoot: "/home/ndf/openclaw-projectworkflow-runs",
        allowedRoots: ["catalog/nexusos/", "docs/nexusos/", "scripts/nexusos/", "tests/nexusos/"],
        deniedRoots: [".env", ".openclaw", "node_modules", "dist", ".git", "secrets", "config"],
        tests: ["python3 -m pytest tests/nexusos"],
      },
    },
  },
} satisfies OpenClawConfig;

const advisoryCfg = {
  ...cfg,
  project_workflows: {
    ...cfg.project_workflows,
    projects: {
      "idp-platform": {
        ...cfg.project_workflows.projects["idp-platform"],
        review: { mode: "advisory" as const },
        architectureReviewer: { enabled: true },
      },
    },
  },
} satisfies OpenClawConfig;

function telegramTopicCtx(body: string) {
  return {
    Body: body,
    CommandBody: body,
    BodyForCommands: body,
    Provider: "telegram",
    Surface: "telegram",
    AccountId: "default",
    To: "-1003958513253",
    OriginatingTo: "-1003958513253",
    MessageThreadId: "2679",
  };
}

const testArchitectRunner = async () => "Propuesta de Claude para pruebas.";

const testImplementerRunner = async () => ({
  status: "completed" as const,
  summary: "Codex aplico cambios en worktree controlado. No deploy, no merge, no push.",
  artifactDir: "/tmp/pwf_test/artifacts",
  worktreePath: "/tmp/pwf_test/worktree",
  branchName: "projectworkflow/pwf_test",
  changedFiles: ["docs/nexusos/example.md"],
  diffStat: " docs/nexusos/example.md | 1 +",
  tests: [{ command: "python3 -m pytest tests/nexusos", status: "passed" as const }],
});

const blockedImplementerRunner = async () => ({
  status: "blocked" as const,
  summary: "Repo aprobado dirty; no se creo worktree ni se ejecuto Codex.",
  blockedReason: "approved repo has uncommitted or untracked changes",
  artifactDir: "/tmp/pwf_test/artifacts",
  changedFiles: [],
  tests: [],
});

const passReviewerRunner = async () => ({
  status: "passed" as const,
  summary:
    "RESULTADO: PASS\n\nHALLAZGOS:\n- sin hallazgos bloqueantes\n\nRECOMENDACION FINAL:\n- aprobar",
  recommendation: "aprobar" as const,
  artifactDir: "/tmp/pwf_test/artifacts",
  stdoutPath: "/tmp/pwf_test/artifacts/reviewer-stdout.log",
  stderrPath: "/tmp/pwf_test/artifacts/reviewer-stderr.log",
});

const failReviewerRunner = async () => ({
  status: "failed" as const,
  summary:
    "RESULTADO: FAIL\n\nHALLAZGOS:\n- falta cubrir criterio critico\n\nRECOMENDACION FINAL:\n- corregir antes de cerrar",
  recommendation: "corregir" as const,
  artifactDir: "/tmp/pwf_test/artifacts",
  stdoutPath: "/tmp/pwf_test/artifacts/reviewer-stdout.log",
  stderrPath: "/tmp/pwf_test/artifacts/reviewer-stderr.log",
  blockedReason: "reviewer reported FAIL",
});

const blockedReviewerRunner = async () => ({
  status: "blocked" as const,
  summary: "Reviewer real dejo cambios en el worktree; revision invalidada.",
  recommendation: "corregir" as const,
  artifactDir: "/tmp/pwf_test/artifacts",
  blockedReason: "reviewer changed worktree status or diff",
});

const passArchitectureReviewerRunner = async () => ({
  status: "passed" as const,
  summary: "RESULTADO: PASS\n\nHALLAZGOS:\n- arquitectura ok\n\nRECOMENDACION FINAL:\n- aprobar",
  recommendation: "aprobar" as const,
  artifactDir: "/tmp/pwf_test/artifacts",
});

const failArchitectureReviewerRunner = async () => ({
  status: "failed" as const,
  summary:
    "RESULTADO: FAIL\n\nHALLAZGOS:\n- riesgo arquitectonico\n\nRECOMENDACION FINAL:\n- corregir antes de cerrar",
  recommendation: "corregir" as const,
  artifactDir: "/tmp/pwf_test/artifacts",
  blockedReason: "architecture reviewer reported FAIL",
});

async function makeStorePath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-workflows-"));
  return path.join(root, "workflows.json");
}

async function queueAndProcessArchitect(
  storePath: string,
  body = "Quiero resolver X",
  config: OpenClawConfig = cfg,
  idFactory = () => "pwf_test",
) {
  await handleProjectWorkflowReply(telegramTopicCtx(body), config, {
    storePath,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    idFactory,
  });
  return await processProjectWorkflowQueue(config, {
    storePath,
    now: () => new Date("2026-06-06T00:00:30.000Z"),
    architectRunner: testArchitectRunner,
  });
}

async function approveAndProcess(
  storePath: string,
  config: OpenClawConfig = cfg,
  runners: Partial<Parameters<typeof processProjectWorkflowQueue>[1]> = {},
) {
  const approval = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), config, {
    storePath,
    now: () => new Date("2026-06-06T00:01:00.000Z"),
  });
  const result = await processProjectWorkflowQueue(config, {
    storePath,
    now: () => new Date("2026-06-06T00:01:30.000Z"),
    implementerRunner: testImplementerRunner,
    ...runners,
  });
  return { approval, result, reply: result.replies.at(-1) };
}

describe("ProjectWorkflow runtime", () => {
  it("creates a queued workflow for the pilot topic without running Architect inline", async () => {
    const storePath = await makeStorePath();
    let architectCalled = false;
    const reply = await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
      architectRunner: async () => {
        architectCalled = true;
        return "should not run inline";
      },
    });

    expect(reply?.text).toContain("workflow_id=pwf_test");
    expect(reply?.text).toContain("phase=architect_queued");
    expect(reply?.text).toContain("project=idp-platform");
    expect(reply?.text).toContain("Recibi el pedido. El Architect esta analizando.");
    expect(architectCalled).toBe(false);

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows).toHaveLength(1);
    expect(store.workflows[0]).toMatchObject({
      workflowId: "pwf_test",
      projectId: "idp-platform",
      status: "architect_queued",
      goal: "Quiero resolver X",
    });
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toEqual([
      "draft_goal",
      "architect_queued",
    ]);
  });

  it("processes architect_queued into awaiting approval", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
    });

    const result = await processProjectWorkflowQueue(cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:30.000Z"),
      architectRunner: testArchitectRunner,
    });

    expect(result.processed).toBe(1);
    expect(result.replies[0]?.text).toContain("phase=awaiting_human_approval");
    expect(result.replies[0]?.text).toContain("Architect (Claude)");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("awaiting_human_approval");
    expect(store.workflows[0]?.artifacts.architectProposal).toBe(
      "Propuesta de Claude para pruebas.",
    );
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toEqual([
      "draft_goal",
      "architect_queued",
      "architect_running",
      "awaiting_human_approval",
    ]);
  });

  it("marks architect_failed with explicit timeout message", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
    });

    const error = new Error("operation timed out");
    const result = await processProjectWorkflowQueue(cfg, {
      storePath,
      architectRunner: async () => {
        throw error;
      },
    });

    expect(result.processed).toBe(1);
    expect(result.replies[0]?.text).toContain("phase=architect_failed");
    expect(result.replies[0]?.text).toContain(
      "Project Workflow Architect timeout after 300 seconds.",
    );

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("architect_failed");
    expect(store.workflows[0]?.artifacts.architectError).toBe(
      "Project Workflow Architect timeout after 300 seconds.",
    );
  });

  it("passes default and configured Architect timeout to the worker runner", async () => {
    const original = process.env.CLAUDE_ARCHITECT_TIMEOUT_MS;
    try {
      delete process.env.CLAUDE_ARCHITECT_TIMEOUT_MS;
      const storePath = await makeStorePath();
      await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
        storePath,
        idFactory: () => "pwf_test",
      });
      const seen: number[] = [];
      await processProjectWorkflowQueue(cfg, {
        storePath,
        architectRunner: async ({ timeoutMs }) => {
          seen.push(timeoutMs);
          return "Propuesta default timeout";
        },
      });
      expect(seen).toEqual([300_000]);

      process.env.CLAUDE_ARCHITECT_TIMEOUT_MS = "450000";
      const storePath2 = await makeStorePath();
      await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
        storePath: storePath2,
        idFactory: () => "pwf_test_2",
      });
      const configured: number[] = [];
      await processProjectWorkflowQueue(cfg, {
        storePath: storePath2,
        architectRunner: async ({ timeoutMs }) => {
          configured.push(timeoutMs);
          return "Propuesta configured timeout";
        },
      });
      expect(configured).toEqual([450_000]);
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_ARCHITECT_TIMEOUT_MS;
      } else {
        process.env.CLAUDE_ARCHITECT_TIMEOUT_MS = original;
      }
    }
  });

  it("does not duplicate Architect execution when the worker runs twice", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
    });
    let calls = 0;
    const first = await processProjectWorkflowQueue(cfg, {
      storePath,
      architectRunner: async () => {
        calls += 1;
        return "Propuesta una vez";
      },
    });
    const second = await processProjectWorkflowQueue(cfg, {
      storePath,
      architectRunner: async () => {
        calls += 1;
        return "No deberia correr";
      },
    });

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0);
    expect(calls).toBe(1);
  });

  it("advances approval through real Codex implementer and simulated reviewer to completed", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    const { approval, reply } = await approveAndProcess(storePath);

    expect(approval?.text).toContain("phase=implementation_queued");
    expect(approval?.text).toContain("Workflow aprobado. Implementer en ejecucion.");
    expect(reply?.text).toContain("phase=completed");
    expect(reply?.text).toContain("Implementer (Codex real)");
    expect(reply?.text).toContain("docs/nexusos/example.md");
    expect(reply?.text).toContain("python3 -m pytest tests/nexusos PASSED");
    expect(reply?.text).toContain("Reviewer simulado: no ejecuto revision semantica real");
    expect(reply?.text).not.toContain("Technical Reviewer: PASS");
    expect(reply?.text).not.toContain("Review simulado aprobado");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("completed");
    expect(store.workflows[0]?.artifacts.implementerStatus).toBe("completed");
    expect(store.workflows[0]?.artifacts.worktreePath).toBe("/tmp/pwf_test/worktree");
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toEqual([
      "draft_goal",
      "architect_queued",
      "architect_running",
      "awaiting_human_approval",
      "approved_for_implementation",
      "implementation_queued",
      "implementer_running",
      "review_queued",
      "reviewer_running",
      "review_passed",
      "completed",
    ]);
  });

  it("marks review_passed before completed when the real reviewer passes", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    const { reply } = await approveAndProcess(storePath, cfg, {
      reviewerRunner: passReviewerRunner,
    });

    expect(reply?.text).toContain("phase=completed");
    expect(reply?.text).toContain("Technical Reviewer: PASS");
    expect(reply?.text).toContain("RESULTADO: PASS");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.artifacts.reviewStatus).toBe("passed");
    expect(store.workflows[0]?.artifacts.reviewStdoutPath).toBe(
      "/tmp/pwf_test/artifacts/reviewer-stdout.log",
    );
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toEqual([
      "draft_goal",
      "architect_queued",
      "architect_running",
      "awaiting_human_approval",
      "approved_for_implementation",
      "implementation_queued",
      "implementer_running",
      "review_queued",
      "reviewer_running",
      "review_passed",
      "completed",
    ]);
  });

  it("marks review_failed when the real reviewer fails", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    const { reply } = await approveAndProcess(storePath, cfg, {
      reviewerRunner: failReviewerRunner,
    });

    expect(reply?.text).toContain("phase=review_failed");
    expect(reply?.text).toContain("Technical Reviewer: FAIL");
    expect(reply?.text).toContain("RECOMENDACION FINAL");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("review_failed");
    expect(store.workflows[0]?.artifacts.reviewStatus).toBe("failed");
  });

  it("blocks when the real reviewer reports worktree mutation", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    const { reply } = await approveAndProcess(storePath, cfg, {
      reviewerRunner: blockedReviewerRunner,
    });

    expect(reply?.text).toContain("phase=blocked");
    expect(reply?.text).toContain("reviewer changed worktree status or diff");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("blocked");
    expect(store.workflows[0]?.artifacts.reviewStatus).toBe("blocked");
  });

  it("completes with warnings in advisory mode when technical reviewer fails", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath, "Quiero resolver X", advisoryCfg);

    const { reply } = await approveAndProcess(storePath, advisoryCfg, {
      reviewerRunner: failReviewerRunner,
      architectureReviewerRunner: passArchitectureReviewerRunner,
    });

    expect(reply?.text).toContain("phase=completed_with_warnings");
    expect(reply?.text).toContain("Technical Reviewer: FAIL");
    expect(reply?.text).toContain("Architecture Reviewer: PASS");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("completed_with_warnings");
    expect(store.workflows[0]?.artifacts.reviewMode).toBe("advisory");
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toContain(
      "completed_with_warnings",
    );
  });

  it("fails architecture review in required mode when architecture reviewer fails", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    const archCfg = {
      ...cfg,
      project_workflows: {
        ...cfg.project_workflows,
        projects: {
          "idp-platform": {
            ...cfg.project_workflows.projects["idp-platform"],
            architectureReviewer: { enabled: true },
          },
        },
      },
    } satisfies OpenClawConfig;
    const { reply } = await approveAndProcess(storePath, archCfg, {
      reviewerRunner: passReviewerRunner,
      architectureReviewerRunner: failArchitectureReviewerRunner,
    });

    expect(reply?.text).toContain("phase=architecture_review_failed");
    expect(reply?.text).toContain("Architecture Reviewer: FAIL");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("architecture_review_failed");
    expect(store.workflows[0]?.artifacts.reviewMode).toBe("required");
  });

  it("blocks the workflow when the real implementer reports an unsafe state", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    const { reply } = await approveAndProcess(storePath, cfg, {
      implementerRunner: blockedImplementerRunner,
    });

    expect(reply?.text).toContain("phase=blocked");
    expect(reply?.text).toContain("Implementer (Codex real): BLOCKED");
    expect(reply?.text).toContain("approved repo has uncommitted or untracked changes");
    expect(reply?.text).toContain("Reviewer simulado: no se ejecuto");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("blocked");
    expect(store.workflows[0]?.artifacts.implementerStatus).toBe("blocked");
  });

  it("recovers stale architect_running into architect_failed", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
      now: () => new Date("2026-06-06T00:00:00.000Z"),
    });
    await updateProjectWorkflowStore((store) => {
      const workflow = store.workflows[0];
      if (!workflow) {
        throw new Error("missing workflow");
      }
      workflow.status = "architect_running";
      workflow.phase = "architect";
      workflow.currentCapability = "architect";
      workflow.updatedAt = "2026-06-06T00:00:01.000Z";
      workflow.phaseStartedAt = "2026-06-06T00:00:01.000Z";
      workflow.auditLog.push({
        at: "2026-06-06T00:00:01.000Z",
        status: "architect_running",
        note: "Architect async iniciado.",
      });
    }, storePath);

    const recovered = await recoverStaleProjectWorkflows(cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:06:02.000Z"),
    });

    expect(recovered.processed).toBe(1);
    expect(recovered.messages[0]?.payload.text).toContain("phase=architect_failed");
    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("architect_failed");
    expect(store.workflows[0]?.artifacts.architectError).toContain(
      "Project Workflow Architect timeout after 300 seconds.",
    );
  });

  it("starts the gateway worker without duplicating ticks", async () => {
    resetProjectWorkflowWorkerForTest();
    const sent: string[] = [];
    let processCalls = 0;
    let intervalCallback: (() => void) | undefined;
    const handle = startProjectWorkflowWorker({
      getConfig: () => cfg,
      setIntervalFn: ((cb: () => void) => {
        intervalCallback = cb;
        return { unref: () => undefined } as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearIntervalFn: (() => undefined) as typeof clearInterval,
      setImmediateFn: ((cb: () => void) => {
        void cb();
        return { unref: () => undefined } as ReturnType<typeof setImmediate>;
      }) as typeof setImmediate,
      recoverStale: async () => ({ processed: 0, replies: [], messages: [] }),
      processQueue: async () => {
        processCalls += 1;
        return {
          processed: 1,
          replies: [{ text: "ok" }],
          messages: [
            {
              route: { channel: "telegram", accountId: "default", chatId: "1", topicId: "2679" },
              payload: { text: "ok" },
            },
          ],
        };
      },
      sendMessage: async (_cfg, message) => {
        sent.push(message.payload.text ?? "");
      },
    });
    const duplicate = startProjectWorkflowWorker({ getConfig: () => cfg });
    intervalCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(duplicate).toBe(handle);
    expect(processCalls).toBe(1);
    expect(sent).toEqual(["ok"]);
    handle.stop();
    resetProjectWorkflowWorkerForTest();
  });

  it("stays inactive when the feature flag is disabled", async () => {
    const storePath = await makeStorePath();
    const reply = await handleProjectWorkflowReply(
      telegramTopicCtx("Quiero resolver X"),
      { project_workflows_enabled: false } satisfies OpenClawConfig,
      { storePath },
    );

    expect(reply).toBeUndefined();
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports the minimal reject, cancel, and status commands", async () => {
    const storePath = await makeStorePath();
    await queueAndProcessArchitect(storePath);

    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("estado"), cfg, { storePath }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("pwf_test") }));
    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("rechazar"), cfg, { storePath }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("phase=rejected") }),
    );

    await queueAndProcessArchitect(storePath, "Quiero resolver Y", cfg, () => "pwf_test_2");
    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("cancelar"), cfg, { storePath }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("phase=cancelled") }),
    );
  });
});
