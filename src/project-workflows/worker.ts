import { sendDurableMessageBatch } from "../channels/message/send.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  processProjectWorkflowQueue,
  recoverStaleProjectWorkflows,
  resolveProjectWorkflowPollIntervalMs,
  type ProjectWorkflowQueueMessage,
} from "./runtime.js";

const log = createSubsystemLogger("project-workflows/worker");

export type ProjectWorkflowWorkerHandle = {
  stop: () => void;
};

export type ProjectWorkflowWorkerOptions = {
  getConfig: () => OpenClawConfig;
  sendMessage?: (cfg: OpenClawConfig, message: ProjectWorkflowQueueMessage) => Promise<void>;
  processQueue?: typeof processProjectWorkflowQueue;
  recoverStale?: typeof recoverStaleProjectWorkflows;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setImmediateFn?: typeof setImmediate;
};

let activeWorker: ProjectWorkflowWorkerHandle | null = null;

async function sendProjectWorkflowMessage(
  cfg: OpenClawConfig,
  message: ProjectWorkflowQueueMessage,
): Promise<void> {
  const result = await sendDurableMessageBatch({
    cfg,
    channel: message.route.channel,
    accountId: message.route.accountId,
    to: message.route.chatId,
    threadId: message.route.topicId,
    payloads: [message.payload],
    durability: "best_effort",
    replyPayloadSendingHook: {
      kind: "final",
      channel: message.route.channel,
      context: {
        channelId: message.route.channel,
        accountId: message.route.accountId,
        conversationId: message.route.chatId,
      },
    },
  });
  if (result.status === "failed" || result.status === "partial_failed") {
    throw result.error;
  }
}

async function deliverMessages(
  cfg: OpenClawConfig,
  messages: readonly ProjectWorkflowQueueMessage[],
  sendMessage: (cfg: OpenClawConfig, message: ProjectWorkflowQueueMessage) => Promise<void>,
): Promise<void> {
  for (const message of messages) {
    try {
      await sendMessage(cfg, message);
    } catch (error) {
      log.warn("project workflow notification failed: " + formatErrorMessage(error));
    }
  }
}

export function startProjectWorkflowWorker(
  opts: ProjectWorkflowWorkerOptions,
): ProjectWorkflowWorkerHandle {
  if (activeWorker) {
    return activeWorker;
  }

  const processQueue = opts.processQueue ?? processProjectWorkflowQueue;
  const recoverStale = opts.recoverStale ?? recoverStaleProjectWorkflows;
  const sendMessage = opts.sendMessage ?? sendProjectWorkflowMessage;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const setImmediateFn = opts.setImmediateFn ?? setImmediate;
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    const cfg = opts.getConfig();
    if (cfg.project_workflows_enabled !== true) {
      return;
    }
    inFlight = true;
    try {
      const stale = await recoverStale(cfg);
      await deliverMessages(cfg, stale.messages, sendMessage);
      const queued = await processQueue(cfg);
      await deliverMessages(cfg, queued.messages, sendMessage);
    } catch (error) {
      log.warn("project workflow worker tick failed: " + formatErrorMessage(error));
    } finally {
      inFlight = false;
    }
  };

  const cfg = opts.getConfig();
  const intervalMs = resolveProjectWorkflowPollIntervalMs(cfg);
  const interval = setIntervalFn(() => {
    void tick();
  }, intervalMs);
  interval.unref?.();
  const immediate = setImmediateFn(() => {
    void tick();
  });
  immediate.unref?.();

  activeWorker = {
    stop: () => {
      stopped = true;
      clearIntervalFn(interval);
      if (activeWorker) {
        activeWorker = null;
      }
    },
  };
  log.info("project workflow async worker started pollIntervalMs=" + intervalMs);
  return activeWorker;
}

export function resetProjectWorkflowWorkerForTest(): void {
  activeWorker?.stop();
  activeWorker = null;
}
