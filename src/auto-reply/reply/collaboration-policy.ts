import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { AgentCollaborationPolicyConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../../plugin-sdk/json-store.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export type CollaborationTaskClass = "research" | "implementation" | "architecture" | "general";

export type CollaborationAuditEntry = {
  ts: number;
  sessionKey?: string;
  agentId?: string;
  taskClass: CollaborationTaskClass;
  promptApplied: boolean;
  coordinatorAgentId?: string;
  researchAgentIds?: string[];
  implementationDelegateAgentId?: string;
  architectureOwnerAgentId?: string;
  architectureReviewAgentId?: string;
  messagePreview?: string;
};

type CollaborationAuditStore = {
  version: 1;
  updatedAt: number;
  entries: CollaborationAuditEntry[];
};

const DEFAULT_COORDINATOR_AGENT_ID = "codex";
const DEFAULT_IMPLEMENTATION_DELEGATE_AGENT_ID = "claude";
const DEFAULT_RESEARCH_AGENT_IDS = ["gemini", "claude"];
const DEFAULT_AUDIT_MAX_ENTRIES = 200;

function resolvePolicyPath(): string {
  return path.join(resolveStateDir(process.env, os.homedir), "agents", "collaboration-policy.json");
}

function sanitizePreview(input: string): string | undefined {
  const compact = input.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

export function resolveCollaborationPolicy(
  cfg: OpenClawConfig | undefined,
): AgentCollaborationPolicyConfig | undefined {
  return cfg?.agents?.defaults?.collaborationPolicy;
}

function resolveCoordinatorAgentId(policy: AgentCollaborationPolicyConfig | undefined): string {
  return normalizeOptionalString(policy?.coordinatorAgentId) ?? DEFAULT_COORDINATOR_AGENT_ID;
}

function resolveImplementationDelegateAgentId(
  policy: AgentCollaborationPolicyConfig | undefined,
): string {
  return (
    normalizeOptionalString(policy?.implementation?.delegateAgentId) ??
    DEFAULT_IMPLEMENTATION_DELEGATE_AGENT_ID
  );
}

function resolveArchitectureOwnerAgentId(
  policy: AgentCollaborationPolicyConfig | undefined,
): string {
  return (
    normalizeOptionalString(policy?.architecture?.ownerAgentId) ?? resolveCoordinatorAgentId(policy)
  );
}

function resolveResearchAgentIds(policy: AgentCollaborationPolicyConfig | undefined): string[] {
  const configured = policy?.research?.preferredAgentIds
    ?.map((value) => value.trim())
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : [...DEFAULT_RESEARCH_AGENT_IDS];
}

export function classifyCollaborationTask(body: string): CollaborationTaskClass {
  const text = normalizeLowercaseStringOrEmpty(body);
  if (!text) {
    return "general";
  }

  const implementationSignals = [
    "implement",
    "implementa",
    "implementá",
    "fix ",
    "arregla",
    "arreglá",
    "bug",
    "refactor",
    "cod",
    "program",
    "feature",
    "endpoint",
    "patch",
    "merge",
    "test",
    "deploy",
  ];
  if (implementationSignals.some((signal) => text.includes(signal))) {
    return "implementation";
  }

  const architectureSignals = [
    "arquitect",
    "architecture",
    "stack",
    "tecnolog",
    "technology",
    "design",
    "diseño",
    "diseno",
    "estructura",
    "system shape",
    "modelo",
  ];
  if (architectureSignals.some((signal) => text.includes(signal))) {
    return "architecture";
  }

  const researchSignals = [
    "investig",
    "research",
    "averigua",
    "look up",
    "analiza",
    "analyze",
    "compare",
    "compar",
    "benchmark",
    "opciones",
    "options",
    "estudio",
    "summary",
  ];
  if (researchSignals.some((signal) => text.includes(signal))) {
    return "research";
  }

  return "general";
}

function buildCoordinatorPrompt(params: {
  policy: AgentCollaborationPolicyConfig;
  taskClass: CollaborationTaskClass;
}): string | undefined {
  const researchAgentIds = resolveResearchAgentIds(params.policy);
  const implementationDelegateAgentId = resolveImplementationDelegateAgentId(params.policy);
  const architectureOwnerAgentId = resolveArchitectureOwnerAgentId(params.policy);
  const architectureReviewAgentId = normalizeOptionalString(
    params.policy.architecture?.reviewAgentId,
  );

  switch (params.taskClass) {
    case "research":
      return [
        "Runtime collaboration policy is active for this turn.",
        `Task class: research. Prefer consulting these agents in order: ${researchAgentIds.join(", ")}.`,
        "Do not stop at a shallow summary. Iterate until the result is concrete and decision-useful.",
        "If the preferred research agent is unavailable, state the fallback reason briefly and continue with the next preferred agent.",
      ].join("\n");
    case "implementation":
      return [
        "Runtime collaboration policy is active for this turn.",
        `Task class: implementation. Delegate the coding work to ${implementationDelegateAgentId} whenever feasible.`,
        "You remain responsible for scoping the work, reviewing progress, correcting gaps, validating the result, and delivering the final answer.",
        "If delegation is impossible due to tool/runtime availability, state that briefly and continue locally instead of blocking.",
      ].join("\n");
    case "architecture":
      return [
        "Runtime collaboration policy is active for this turn.",
        `Task class: architecture. ${architectureOwnerAgentId} owns the architecture, design, and stack choice.`,
        architectureReviewAgentId
          ? `Obtain an early review from ${architectureReviewAgentId} before implementation begins.`
          : "Obtain an early review before implementation begins.",
        "If a The-Architect harness or skill exists in the runtime, use it for first-pass shaping before the review step; otherwise shape the architecture yourself and still get the review.",
      ].join("\n");
    default:
      return undefined;
  }
}

function buildSpecialistPrompt(params: {
  policy: AgentCollaborationPolicyConfig;
  agentId: string;
  taskClass: CollaborationTaskClass;
}): string | undefined {
  const normalizedAgentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const implementationDelegateAgentId = normalizeLowercaseStringOrEmpty(
    resolveImplementationDelegateAgentId(params.policy),
  );
  const architectureReviewAgentId = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.policy.architecture?.reviewAgentId),
  );
  const researchAgentIds = resolveResearchAgentIds(params.policy).map((value) =>
    normalizeLowercaseStringOrEmpty(value),
  );

  if (
    params.taskClass === "implementation" &&
    normalizedAgentId === implementationDelegateAgentId
  ) {
    return [
      "Runtime collaboration policy is active for this turn.",
      "You are the delegated implementation agent.",
      "Focus on executing the code changes, testing what you can, and reporting concrete file-level outcomes and risks back to the coordinator.",
    ].join("\n");
  }

  if (params.taskClass === "research" && researchAgentIds.includes(normalizedAgentId)) {
    return [
      "Runtime collaboration policy is active for this turn.",
      "You are acting as a research specialist for this turn.",
      "Return concrete findings, alternatives, tradeoffs, and risks. Optimize for decision value, not generic explanation.",
    ].join("\n");
  }

  if (params.taskClass === "architecture" && normalizedAgentId === architectureReviewAgentId) {
    return [
      "Runtime collaboration policy is active for this turn.",
      "You are acting as the architecture reviewer.",
      "Challenge weak assumptions, surface risks, and give a concrete go/no-go review before implementation starts.",
    ].join("\n");
  }

  return undefined;
}

export async function recordCollaborationAuditEntry(params: {
  cfg: OpenClawConfig | undefined;
  entry: CollaborationAuditEntry;
}): Promise<void> {
  const policy = resolveCollaborationPolicy(params.cfg);
  if (policy?.enabled !== true || policy.audit?.enabled === false) {
    return;
  }
  const limit = Math.max(1, policy.audit?.maxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES);
  const filePath = resolvePolicyPath();
  const fallback: CollaborationAuditStore = { version: 1, updatedAt: 0, entries: [] };
  const { value } = await readJsonFileWithFallback<CollaborationAuditStore>(filePath, fallback);
  const next: CollaborationAuditStore = {
    version: 1,
    updatedAt: Date.now(),
    entries: [params.entry, ...(Array.isArray(value.entries) ? value.entries : [])].slice(0, limit),
  };
  await writeJsonFileAtomically(filePath, next);
}

export async function loadCollaborationAuditStore(): Promise<CollaborationAuditStore> {
  const fallback: CollaborationAuditStore = { version: 1, updatedAt: 0, entries: [] };
  const { value } = await readJsonFileWithFallback<CollaborationAuditStore>(
    resolvePolicyPath(),
    fallback,
  );
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    entries: Array.isArray(value.entries) ? value.entries : [],
  };
}

export async function buildCollaborationPolicyTurnPrompt(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  sessionKey?: string;
  body: string;
}): Promise<{ prompt?: string; entry?: CollaborationAuditEntry }> {
  const policy = resolveCollaborationPolicy(params.cfg);
  if (policy?.enabled !== true) {
    return {};
  }

  const taskClass = classifyCollaborationTask(params.body);
  const normalizedAgentId = normalizeOptionalString(params.agentId);
  const coordinatorAgentId = resolveCoordinatorAgentId(policy);
  const isCoordinator =
    normalizeLowercaseStringOrEmpty(normalizedAgentId) ===
    normalizeLowercaseStringOrEmpty(coordinatorAgentId);

  const prompt = isCoordinator
    ? buildCoordinatorPrompt({ policy, taskClass })
    : normalizedAgentId
      ? buildSpecialistPrompt({ policy, agentId: normalizedAgentId, taskClass })
      : undefined;

  const entry: CollaborationAuditEntry = {
    ts: Date.now(),
    sessionKey: normalizeOptionalString(params.sessionKey),
    agentId: normalizedAgentId,
    taskClass,
    promptApplied: typeof prompt === "string" && prompt.trim().length > 0,
    coordinatorAgentId,
    researchAgentIds: resolveResearchAgentIds(policy),
    implementationDelegateAgentId: resolveImplementationDelegateAgentId(policy),
    architectureOwnerAgentId: resolveArchitectureOwnerAgentId(policy),
    architectureReviewAgentId: normalizeOptionalString(policy.architecture?.reviewAgentId),
    messagePreview: sanitizePreview(params.body),
  };

  await recordCollaborationAuditEntry({ cfg: params.cfg, entry });
  return { prompt, entry };
}

export async function buildCollaborationPolicyStatus(params: {
  cfg: OpenClawConfig | undefined;
}): Promise<{
  policy: AgentCollaborationPolicyConfig | null;
  audit: {
    updatedAt: number;
    total: number;
    byTaskClass: Record<CollaborationTaskClass, number>;
    recent: CollaborationAuditEntry[];
  };
}> {
  const store = await loadCollaborationAuditStore();
  const byTaskClass: Record<CollaborationTaskClass, number> = {
    research: 0,
    implementation: 0,
    architecture: 0,
    general: 0,
  };
  for (const entry of store.entries) {
    if (entry.taskClass in byTaskClass) {
      byTaskClass[entry.taskClass] += 1;
    }
  }
  return {
    policy: resolveCollaborationPolicy(params.cfg) ?? null,
    audit: {
      updatedAt: store.updatedAt,
      total: store.entries.length,
      byTaskClass,
      recent: store.entries.slice(0, 20),
    },
  };
}
