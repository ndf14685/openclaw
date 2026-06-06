import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig, ProjectWorkflowPilotConfig } from "../config/config.js";
import { resolveProjectWorkflowStorePath, updateProjectWorkflowStore } from "./store.js";
import type {
  ProjectWorkflowAuditEvent,
  ProjectWorkflowCommand,
  ProjectWorkflowRecord,
  ProjectWorkflowRoute,
  ProjectWorkflowStatus,
} from "./types.js";

const DEFAULT_PILOT: Required<ProjectWorkflowPilotConfig> = {
  channel: "telegram",
  accountId: "default",
  chatId: "*",
  topicId: "2679",
  projectId: "idp-platform",
};

const TERMINAL_STATUSES = new Set<ProjectWorkflowStatus>(["completed", "rejected", "cancelled"]);

export type ProjectWorkflowRuntimeOptions = {
  storePath?: string;
  now?: () => Date;
  idFactory?: () => string;
  isHeartbeat?: boolean;
};

function routeKey(route: ProjectWorkflowRoute): string {
  return `${route.channel}:${route.accountId}:${route.chatId}:topic:${route.topicId}`;
}

function normalizeCommandText(ctx: MsgContext): string {
  return (
    normalizeOptionalString(ctx.BodyForCommands) ??
    normalizeOptionalString(ctx.CommandBody) ??
    normalizeOptionalString(ctx.RawBody) ??
    normalizeOptionalString(ctx.Body) ??
    ""
  ).trim();
}

function classifyCommand(text: string): ProjectWorkflowCommand {
  const normalized = text
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
  if (normalized === "aprobar") {
    return "approve";
  }
  if (normalized === "rechazar") {
    return "reject";
  }
  if (normalized === "cancelar") {
    return "cancel";
  }
  if (normalized === "estado") {
    return "status";
  }
  return "goal";
}

function resolveRoute(ctx: MsgContext): ProjectWorkflowRoute | null {
  const channel = normalizeOptionalString(ctx.Surface) ?? normalizeOptionalString(ctx.Provider);
  if (channel !== "telegram") {
    return null;
  }
  const topicId = normalizeOptionalString(ctx.MessageThreadId);
  const chatId =
    normalizeOptionalString(ctx.OriginatingTo) ??
    normalizeOptionalString(ctx.To) ??
    normalizeOptionalString(ctx.NativeChannelId);
  if (!topicId || !chatId) {
    return null;
  }
  return {
    channel: "telegram",
    accountId: normalizeOptionalString(ctx.AccountId) ?? "default",
    chatId,
    topicId,
  };
}

function resolvePilot(
  cfg: OpenClawConfig,
  route: ProjectWorkflowRoute,
): Required<ProjectWorkflowPilotConfig> | null {
  const pilots = cfg.project_workflows?.pilots?.length
    ? cfg.project_workflows.pilots
    : [DEFAULT_PILOT];
  for (const pilot of pilots) {
    const channel = pilot.channel ?? "telegram";
    const accountId = pilot.accountId ?? "default";
    const chatId = pilot.chatId ?? "*";
    if (channel !== route.channel) {
      continue;
    }
    if (accountId !== route.accountId) {
      continue;
    }
    if (pilot.topicId !== route.topicId) {
      continue;
    }
    if (chatId !== "*" && chatId !== route.chatId) {
      continue;
    }
    return {
      channel,
      accountId,
      chatId,
      topicId: pilot.topicId,
      projectId: pilot.projectId,
    };
  }
  return null;
}

function appendAudit(
  workflow: ProjectWorkflowRecord,
  status: ProjectWorkflowStatus,
  note: string,
  at: string,
): void {
  workflow.auditLog.push({ at, status, note } satisfies ProjectWorkflowAuditEvent);
}

function createWorkflow(params: {
  workflowId: string;
  projectId: string;
  route: ProjectWorkflowRoute;
  goal: string;
  at: string;
}): ProjectWorkflowRecord {
  const workflow: ProjectWorkflowRecord = {
    workflowId: params.workflowId,
    projectId: params.projectId,
    route: params.route,
    goal: params.goal,
    status: "awaiting_human_approval",
    phase: "approval",
    currentCapability: "architect",
    artifacts: {
      architectProposal: "Propuesta generada.",
    },
    auditLog: [],
    createdAt: params.at,
    updatedAt: params.at,
  };
  appendAudit(workflow, "draft_goal", "Goal recibido y normalizado.", params.at);
  appendAudit(workflow, "architect_running", "Architect simulado genero una propuesta.", params.at);
  appendAudit(workflow, "awaiting_human_approval", "Esperando aprobacion humana.", params.at);
  return workflow;
}

function completeWorkflow(workflow: ProjectWorkflowRecord, at: string): void {
  workflow.status = "completed";
  workflow.phase = "result";
  workflow.currentCapability = "reviewer";
  workflow.artifacts.implementationSummary = "Implementacion simulada completada.";
  workflow.artifacts.reviewSummary = "Review simulado aprobado.";
  workflow.updatedAt = at;
  appendAudit(workflow, "approved_for_implementation", "Aprobacion humana registrada.", at);
  appendAudit(
    workflow,
    "implementer_running",
    "Implementer simulado ejecuto el plan aprobado.",
    at,
  );
  appendAudit(workflow, "reviewer_running", "Reviewer simulado valido el resultado.", at);
  appendAudit(workflow, "completed", "Workflow simulado completado.", at);
}

function formatWorkflowHeader(workflow: ProjectWorkflowRecord): string {
  return [
    "[Workflow]",
    `workflow_id=${workflow.workflowId}`,
    `phase=${workflow.status}`,
    `project=${workflow.projectId}`,
  ].join("\n");
}

function formatApprovalReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: `${formatWorkflowHeader(workflow)}\n\nArchitect (simulado):\n${
      workflow.artifacts.architectProposal ?? "Propuesta generada."
    }\n\n¿Aprobar?\n\nComandos: aprobar | rechazar | cancelar | estado`,
  };
}

function formatStatusReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  const lastEvent = workflow.auditLog.at(-1);
  return {
    text: `${formatWorkflowHeader(workflow)}\n\nGoal:\n${workflow.goal}\n\nUltimo evento: ${
      lastEvent?.note ?? "sin eventos"
    }\n\nModo: dry-run / no-agent / no-write`,
  };
}

function formatNoActiveWorkflowReply(route: ProjectWorkflowRoute, projectId: string): ReplyPayload {
  return {
    text: [
      "[Workflow]",
      "workflow_id=none",
      "phase=idle",
      `project=${projectId}`,
      `route=${routeKey(route)}`,
      "",
      "No hay un ProjectWorkflow activo.",
    ].join("\n"),
  };
}

function formatCompletedReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: `${formatWorkflowHeader(workflow)}\n\nImplementer (simulado):\n${
      workflow.artifacts.implementationSummary ?? "Implementacion simulada completada."
    }\n\nReviewer (simulado):\n${
      workflow.artifacts.reviewSummary ?? "Review simulado aprobado."
    }\n\nResultado:\nWorkflow dry-run completado sin ejecutar agentes reales.`,
  };
}

function formatTerminalReply(workflow: ProjectWorkflowRecord, label: string): ReplyPayload {
  return {
    text: `${formatWorkflowHeader(workflow)}\n\n${label}\n\nModo: dry-run / no-agent / no-write`,
  };
}

function findActiveWorkflow(
  workflows: ProjectWorkflowRecord[],
  route: ProjectWorkflowRoute,
): ProjectWorkflowRecord | undefined {
  const key = routeKey(route);
  return workflows
    .filter(
      (workflow) => routeKey(workflow.route) === key && !TERMINAL_STATUSES.has(workflow.status),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export async function handleProjectWorkflowReply(
  ctx: MsgContext,
  cfg: OpenClawConfig,
  opts: ProjectWorkflowRuntimeOptions = {},
): Promise<ReplyPayload | undefined> {
  if (cfg.project_workflows_enabled !== true || opts.isHeartbeat === true) {
    return undefined;
  }
  const route = resolveRoute(ctx);
  if (!route) {
    return undefined;
  }
  const pilot = resolvePilot(cfg, route);
  if (!pilot) {
    return undefined;
  }

  const text = normalizeCommandText(ctx);
  const command = classifyCommand(text);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const workflowId =
    opts.idFactory?.() ?? `pwf_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const storePath = opts.storePath ?? resolveProjectWorkflowStorePath();

  return await updateProjectWorkflowStore((store) => {
    const active = findActiveWorkflow(store.workflows, route);

    if (!active) {
      if (command === "status") {
        return formatNoActiveWorkflowReply(route, pilot.projectId);
      }
      if (command === "approve" || command === "reject" || command === "cancel") {
        return formatNoActiveWorkflowReply(route, pilot.projectId);
      }
      const workflow = createWorkflow({
        workflowId,
        projectId: pilot.projectId,
        route,
        goal: text || "Goal sin texto",
        at: now,
      });
      store.workflows.push(workflow);
      return formatApprovalReply(workflow);
    }

    if (command === "status") {
      return formatStatusReply(active);
    }
    if (command === "cancel") {
      active.status = "cancelled";
      active.phase = "result";
      active.updatedAt = now;
      appendAudit(active, "cancelled", "Workflow cancelado por el operador.", now);
      return formatTerminalReply(active, "Workflow cancelado.");
    }
    if (command === "reject") {
      active.status = "rejected";
      active.phase = "result";
      active.updatedAt = now;
      appendAudit(active, "rejected", "Propuesta rechazada por el operador.", now);
      return formatTerminalReply(active, "Propuesta rechazada.");
    }
    if (command === "approve") {
      completeWorkflow(active, now);
      return formatCompletedReply(active);
    }

    const workflow = createWorkflow({
      workflowId,
      projectId: pilot.projectId,
      route,
      goal: text || "Goal sin texto",
      at: now,
    });
    store.workflows.push(workflow);
    return formatApprovalReply(workflow);
  }, storePath);
}
