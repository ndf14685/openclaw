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

async function makeStorePath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-workflows-"));
  return path.join(root, "workflows.json");
}

describe("ProjectWorkflow dry-run runtime", () => {
  it("creates a workflow for the pilot topic and waits for approval", async () => {
    const storePath = await makeStorePath();
    const reply = await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
    });

    expect(reply?.text).toContain("workflow_id=pwf_test");
    expect(reply?.text).toContain("phase=awaiting_human_approval");
    expect(reply?.text).toContain("project=idp-platform");
    expect(reply?.text).toContain("Architect (simulado)");

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

  it("advances approval through simulated implementer and reviewer to completed", async () => {
    const storePath = await makeStorePath();
    await handleProjectWorkflowReply(telegramTopicCtx("Quiero resolver X"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:00:00.000Z"),
      idFactory: () => "pwf_test",
    });

    const reply = await handleProjectWorkflowReply(telegramTopicCtx("aprobar"), cfg, {
      storePath,
      now: () => new Date("2026-06-06T00:01:00.000Z"),
    });

    expect(reply?.text).toContain("phase=completed");
    expect(reply?.text).toContain("Implementer (simulado)");
    expect(reply?.text).toContain("Reviewer (simulado)");
    expect(reply?.text).toContain("sin ejecutar agentes reales");

    const store = await readProjectWorkflowStore(storePath);
    expect(store.workflows[0]?.status).toBe("completed");
    expect(store.workflows[0]?.auditLog.map((event) => event.status)).toEqual([
      "draft_goal",
      "architect_running",
      "awaiting_human_approval",
      "approved_for_implementation",
      "implementer_running",
      "reviewer_running",
      "completed",
    ]);
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
    });
    await expect(
      handleProjectWorkflowReply(telegramTopicCtx("cancelar"), cfg, { storePath }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("phase=cancelled") }),
    );
  });
});
