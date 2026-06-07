import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { handleProjectWorkflowReply } from "./runtime.js";
import { readProjectWorkflowStore } from "./store.js";

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

describe("ProjectWorkflow runtime", () => {
  it("creates a workflow for the pilot topic and waits for approval", async () => {
    const storePath = await makeStorePath();
    const reply = await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    expect(reply?.text).toContain("workflow_id=pwf_test");
    expect(reply?.text).toContain("phase=awaiting_human_approval");
    expect(reply?.text).toContain("project=idp-platform");
    expect(reply?.text).toContain("Architect (Claude)");
    expect(reply?.text).toContain("Propuesta de Claude para pruebas.");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows).toHaveLength(1);
    expect(store.workflows[0]).toMatchObject({
      workflowId: "pwf_test",
      projectId: "idp-platform",
      status: "awaiting_human_approval",
      goal: "Quiero resolver X",
    });
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toEqual([
      "draft_goal",
      "architect_running",
      "awaiting_human_approval",
    ]);
  });

  it("advances approval through real Codex implementer and simulated reviewer to completed", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:01:00.000Z"),
      implementerRunner: testImplementerRunner,
    });

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
      "architect_running",
      "awaiting_human_approval",
      "approved_for_implementation",
      "implementer_running",
      "reviewer_running",
      "review_passed",
      "completed",
    ]);
  });

  it("marks review_passed before completed when the real reviewer passes", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:01:00.000Z"),
      implementerRunner: testImplementerRunner,
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
      "architect_running",
      "awaiting_human_approval",
      "approved_for_implementation",
      "implementer_running",
      "reviewer_running",
      "review_passed",
      "completed",
    ]);
  });

  it("marks review_failed when the real reviewer fails", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      implementerRunner: testImplementerRunner,
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
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      implementerRunner: testImplementerRunner,
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
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), advisoryCfg, {
      storePath,
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), advisoryCfg, {
      storePath,
      implementerRunner: testImplementerRunner,
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
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      implementerRunner: testImplementerRunner,
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
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:01:00.000Z"),
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
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      idFactory: () => "pwf_test",
      architectRunner: testArchitectRunner,
    });

    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("estado"), cfg, { storePath }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("pwf_test") }));
    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("rechazar"), cfg, { storePath }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("phase=rejected") }),
    );

    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver Y"), cfg, {
      storePath,
      idFactory: () => "pwf_test_2",
      architectRunner: testArchitectRunner,
    });
    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("cancelar"), cfg, { storePath }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("phase=cancelled") }),
    );
  });
});
