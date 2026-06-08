import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type {
  OpenClawConfig,
  ProjectWorkflowPilotConfig,
  ProjectWorkflowProjectConfig,
} from "../config/config.js";
import { resolveProjectWorkflowStorePath, updateProjectWorkflowStore } from "./store.js";
import type {
  ProjectWorkflowAuditEvent,
  ProjectWorkflowCommand,
  ProjectWorkflowRecord,
  ProjectWorkflowRoute,
  ProjectWorkflowStatus,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CLAUDE_ARCHITECT_TIMEOUT_MS = 300_000;
const CLAUDE_ARCHITECT_MAX_BUFFER = 64 * 1024;
const CODEX_IMPLEMENTER_TIMEOUT_MS = 300_000;
const CODEX_REVIEWER_TIMEOUT_MS = 300_000;
const IMPLEMENTER_MAX_BUFFER = 256 * 1024;

const DEFAULT_PILOT: Required<ProjectWorkflowPilotConfig> = {
  channel: "telegram",
  accountId: "default",
  chatId: "*",
  topicId: "2679",
  projectId: "idp-platform",
};

const DEFAULT_PROJECTS: Record<string, ProjectWorkflowProjectConfig> = {
  "idp-platform": {
    repoPath: "/home/ndf/idp-platform",
    worktreeRoot: "/home/ndf/openclaw-projectworkflow-runs",
    allowedRoots: ["catalog/nexusos/", "docs/nexusos/", "scripts/nexusos/", "tests/nexusos/"],
    deniedRoots: [
      ".env",
      ".env.",
      ".openclaw",
      "node_modules",
      "dist",
      ".git",
      "secrets",
      "config",
    ],
    tests: [],
  },
};

const TERMINAL_STATUSES = new Set<ProjectWorkflowStatus>([
  "completed",
  "completed_with_warnings",
  "review_failed",
  "architecture_review_failed",
  "architect_failed",
  "rejected",
  "cancelled",
  "blocked",
]);

type ArchitectRunner = (params: {
  goal: string;
  projectId: string;
  timeoutMs: number;
}) => Promise<string>;

type ImplementerTestResult = {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  logPath?: string;
};

type ImplementerResult = {
  status: "completed" | "blocked";
  summary: string;
  blockedReason?: string;
  artifactDir: string;
  worktreePath?: string;
  branchName?: string;
  changedFiles: string[];
  diffStat?: string;
  tests: ImplementerTestResult[];
};

type ReviewMode = "advisory" | "required";

type ReviewerResult = {
  status: "passed" | "failed" | "blocked" | "simulated" | "skipped";
  summary: string;
  recommendation?: "aprobar" | "corregir";
  findings?: string[];
  risks?: string[];
  verifiedTests?: string[];
  acceptanceCriteria?: string[];
  stdoutPath?: string;
  stderrPath?: string;
  gitStatusBeforePath?: string;
  gitStatusAfterPath?: string;
  diffBeforePath?: string;
  diffAfterPath?: string;
  artifactDir: string;
  blockedReason?: string;
};

type ResolvedProjectWorkflowProjectConfig = ProjectWorkflowProjectConfig & { projectId: string };

export type ProjectWorkflowRuntimeOptions = {
  storePath?: string;
  now?: () => Date;
  idFactory?: () => string;
  isHeartbeat?: boolean;
  architectRunner?: ArchitectRunner;
  implementerRunner?: (params: {
    workflow: ProjectWorkflowRecord;
    project: ResolvedProjectWorkflowProjectConfig;
  }) => Promise<ImplementerResult>;
  reviewerRunner?: (params: {
    workflow: ProjectWorkflowRecord;
    project: ResolvedProjectWorkflowProjectConfig;
    implementerResult: ImplementerResult;
  }) => Promise<ReviewerResult>;
  architectureReviewerRunner?: (params: {
    workflow: ProjectWorkflowRecord;
    project: ResolvedProjectWorkflowProjectConfig;
    implementerResult: ImplementerResult;
  }) => Promise<ReviewerResult>;
};

function resolveClaudeArchitectTimeoutMs(): number {
  const raw = process.env.CLAUDE_ARCHITECT_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_CLAUDE_ARCHITECT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CLAUDE_ARCHITECT_TIMEOUT_MS;
}

function formatArchitectTimeoutMessage(timeoutMs: number): string {
  return "Project Workflow Architect timeout after " + Math.ceil(timeoutMs / 1000) + " seconds.";
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { signal?: unknown; killed?: unknown; code?: unknown; message?: unknown };
  return (
    record.signal === "SIGTERM" ||
    record.killed === true ||
    record.code === "ETIMEDOUT" ||
    String(record.message ?? "")
      .toLowerCase()
      .includes("timed out") ||
    String(record.message ?? "")
      .toLowerCase()
      .includes("timeout")
  );
}

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

function normalizeRouteField(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized) {
    return normalized;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function getTelegramRouteParts(ctx: MsgContext): {
  channel?: string;
  accountId: string;
  chatId?: string;
  topicId?: string;
} {
  return {
    channel: normalizeRouteField(ctx.Surface) ?? normalizeRouteField(ctx.Provider),
    accountId: normalizeRouteField(ctx.AccountId) ?? "default",
    chatId:
      normalizeRouteField(ctx.OriginatingTo) ??
      normalizeRouteField(ctx.To) ??
      normalizeRouteField(ctx.NativeChannelId),
    topicId: normalizeRouteField(ctx.MessageThreadId),
  };
}

function resolveRoute(ctx: MsgContext): ProjectWorkflowRoute | null {
  const parts = getTelegramRouteParts(ctx);
  if (parts.channel !== "telegram" || !parts.topicId) {
    return null;
  }
  return {
    channel: "telegram",
    accountId: parts.accountId,
    chatId: parts.chatId ?? "*",
    topicId: parts.topicId,
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
    const channel = normalizeRouteField(pilot.channel) ?? "telegram";
    const accountId = normalizeRouteField(pilot.accountId) ?? "default";
    const chatId = normalizeRouteField(pilot.chatId) ?? "*";
    const topicId = normalizeRouteField(pilot.topicId);
    if (channel !== route.channel) {
      continue;
    }
    if (accountId !== route.accountId) {
      continue;
    }
    if (topicId !== route.topicId) {
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

function createQueuedWorkflow(params: {
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
    status: "architect_queued",
    phase: "architect",
    currentCapability: "architect",
    artifacts: {},
    auditLog: [],
    createdAt: params.at,
    updatedAt: params.at,
  };
  appendAudit(workflow, "draft_goal", "Goal recibido y normalizado.", params.at);
  appendAudit(workflow, "architect_queued", "Architect encolado para ejecucion async.", params.at);
  return workflow;
}

function completeArchitectProposal(
  workflow: ProjectWorkflowRecord,
  architectProposal: string,
  at: string,
): void {
  workflow.status = "awaiting_human_approval";
  workflow.phase = "approval";
  workflow.currentCapability = "architect";
  workflow.artifacts.architectProposal = architectProposal;
  workflow.updatedAt = at;
  appendAudit(workflow, "awaiting_human_approval", "Esperando aprobacion humana.", at);
}

function failArchitect(workflow: ProjectWorkflowRecord, errorMessage: string, at: string): void {
  workflow.status = "architect_failed";
  workflow.phase = "result";
  workflow.currentCapability = "architect";
  workflow.artifacts.architectError = errorMessage;
  workflow.updatedAt = at;
  appendAudit(workflow, "architect_failed", errorMessage, at);
}

function buildArchitectPrompt(goal: string, projectId: string): string {
  return [
    "Actua como Architect dentro de ProjectWorkflow.",
    "Genera una propuesta tecnica breve y accionable para aprobacion humana.",
    "No ejecutes cambios. No apruebes. No implementes.",
    "Incluye: objetivo, plan, riesgos, criterios de aceptacion.",
    "Responde en espanol, conciso.",
    "",
    `Proyecto: ${projectId}`,
    `Goal: ${goal}`,
  ].join("\n");
}

async function runClaudeArchitect(params: {
  goal: string;
  projectId: string;
  timeoutMs: number;
}): Promise<string> {
  const claudePath =
    process.env.OPENCLAW_PROJECT_WORKFLOW_CLAUDE_CLI ?? "/home/ndf/.local/bin/claude";
  const { stdout } = await execFileAsync(
    claudePath,
    [
      "--print",
      "--no-session-persistence",
      "--tools",
      "",
      "--max-budget-usd",
      "0.50",
      buildArchitectPrompt(params.goal, params.projectId),
    ],
    {
      timeout: params.timeoutMs,
      maxBuffer: CLAUDE_ARCHITECT_MAX_BUFFER,
    },
  );
  const proposal = normalizeOptionalString(stdout);
  if (!proposal) {
    throw new Error("Claude Architect returned an empty proposal.");
  }
  return proposal;
}

function resolveReviewMode(project: ResolvedProjectWorkflowProjectConfig): ReviewMode {
  return project.review?.mode ?? "required";
}

function resolveProjectConfig(
  cfg: OpenClawConfig,
  projectId: string,
): ResolvedProjectWorkflowProjectConfig | null {
  const project = cfg.project_workflows?.projects?.[projectId] ?? DEFAULT_PROJECTS[projectId];
  return project ? { ...project, projectId } : null;
}

function defaultArtifactRoot(workflowId: string): string {
  return path.join(
    process.env.HOME ?? "/home/ndf",
    ".openclaw",
    "state",
    "project-workflows",
    "runs",
    workflowId,
  );
}

function normalizeRepoRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeRoot(value: string): string {
  const normalized = normalizeRepoRelativePath(value).replace(/^\/+/, "");
  if (!normalized || normalized === ".") {
    return "";
  }
  return normalized.endsWith("/") ? normalized : normalized + "/";
}

function isUnderRoot(file: string, root: string): boolean {
  const normalizedFile = normalizeRepoRelativePath(file);
  const normalizedRoot = normalizeRoot(root);
  if (!normalizedRoot) {
    return true;
  }
  return (
    normalizedFile === normalizedRoot.slice(0, -1) || normalizedFile.startsWith(normalizedRoot)
  );
}

function findScopeViolation(
  changedFiles: string[],
  allowedRoots: string[],
  deniedRoots: string[],
): string | null {
  for (const file of changedFiles) {
    const normalized = normalizeRepoRelativePath(file);
    if (normalized.startsWith("../") || path.isAbsolute(normalized)) {
      return file + " is outside the repository";
    }
    if (!allowedRoots.some((root) => isUnderRoot(normalized, root))) {
      return file + " is outside allowedRoots";
    }
    if (deniedRoots.some((root) => isUnderRoot(normalized, root))) {
      return file + " is inside deniedRoots";
    }
  }
  return null;
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      code?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return [
      normalizeOptionalString(record.message),
      record.code === undefined ? undefined : "code=" + String(record.code),
      record.signal === undefined ? undefined : "signal=" + String(record.signal),
      normalizeOptionalString(record.stderr),
      normalizeOptionalString(record.stdout),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return String(error);
}

async function runGit(
  args: string[],
  cwd: string,
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: options.timeout ?? 60_000,
    maxBuffer: IMPLEMENTER_MAX_BUFFER,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

function buildCodexPrompt(
  workflow: ProjectWorkflowRecord,
  project: ResolvedProjectWorkflowProjectConfig,
): string {
  const tests = project.tests?.length
    ? project.tests.map((test) => "- " + test).join("\n")
    : "- No tests configured; do not invent test commands.";
  return [
    "You are the real Implementer inside OpenClaw ProjectWorkflow Fase 1.",
    "Work only inside the provided worktree. Do not deploy, restart services, push, merge, edit secrets, or touch live config.",
    "If the approved proposal cannot be applied safely inside scope, stop and explain why.",
    "Do not commit changes. Leave the diff in the worktree.",
    "",
    "Project: " + project.projectId,
    "Allowed roots: " + project.allowedRoots.join(", "),
    "Denied roots: " + ((project.deniedRoots ?? []).join(", ") || "none"),
    "Configured tests:",
    tests,
    "",
    "Original goal:",
    workflow.goal,
    "",
    "Approved Architect proposal:",
    workflow.artifacts.architectProposal ?? "",
  ].join("\n");
}

async function writeArtifact(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function blockedImplementerResult(params: {
  artifactDir: string;
  summary: string;
  blockedReason: string;
  worktreePath?: string;
  branchName?: string;
  changedFiles?: string[];
  diffStat?: string;
  tests?: ImplementerTestResult[];
}): Promise<ImplementerResult> {
  await writeArtifact(
    path.join(params.artifactDir, "result.json"),
    JSON.stringify({ status: "blocked", blockedReason: params.blockedReason }, null, 2) + "\n",
  );
  return {
    status: "blocked",
    summary: params.summary,
    blockedReason: params.blockedReason,
    artifactDir: params.artifactDir,
    worktreePath: params.worktreePath,
    branchName: params.branchName,
    changedFiles: params.changedFiles ?? [],
    diffStat: params.diffStat,
    tests: params.tests ?? [],
  };
}

async function runCodexImplementer(params: {
  workflow: ProjectWorkflowRecord;
  project: ResolvedProjectWorkflowProjectConfig;
}): Promise<ImplementerResult> {
  const { workflow, project } = params;
  const artifactDir = defaultArtifactRoot(workflow.workflowId);
  await fs.mkdir(artifactDir, { recursive: true });
  await writeArtifact(
    path.join(artifactDir, "architect-proposal.md"),
    workflow.artifacts.architectProposal ?? "",
  );

  let repoStatus = "";
  try {
    repoStatus = (await runGit(["status", "--porcelain"], project.repoPath)).stdout.trim();
  } catch (error) {
    return await blockedImplementerResult({
      artifactDir,
      summary: "No se pudo inspeccionar el repo aprobado.",
      blockedReason: formatExecError(error),
    });
  }
  await writeArtifact(path.join(artifactDir, "git-status-before.txt"), repoStatus + "\n");
  if (repoStatus) {
    return await blockedImplementerResult({
      artifactDir,
      summary: "Repo aprobado dirty; no se creo worktree ni se ejecuto Codex.",
      blockedReason: "approved repo has uncommitted or untracked changes",
    });
  }

  const branchName = "projectworkflow/" + workflow.workflowId;
  const worktreeRoot =
    project.worktreeRoot ??
    path.join(path.dirname(project.repoPath), "openclaw-projectworkflow-runs");
  const worktreePath = path.join(worktreeRoot, workflow.workflowId);
  await fs.mkdir(worktreeRoot, { recursive: true });

  try {
    await runGit(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], project.repoPath, {
      timeout: 120_000,
    });
  } catch (error) {
    return await blockedImplementerResult({
      artifactDir,
      summary: "No se pudo crear el worktree controlado.",
      blockedReason: formatExecError(error),
      worktreePath,
      branchName,
    });
  }

  const codexPrompt = buildCodexPrompt(workflow, project);
  await writeArtifact(path.join(artifactDir, "codex-prompt.md"), codexPrompt);

  try {
    const codexCli = project.codexCli ?? process.env.OPENCLAW_PROJECT_WORKFLOW_CODEX_CLI ?? "codex";
    const { stdout, stderr } = await execFileAsync(
      codexCli,
      ["exec", "--cd", worktreePath, codexPrompt],
      {
        cwd: worktreePath,
        timeout: project.codexTimeoutMs ?? CODEX_IMPLEMENTER_TIMEOUT_MS,
        maxBuffer: IMPLEMENTER_MAX_BUFFER,
      },
    );
    await writeArtifact(path.join(artifactDir, "codex-stdout.log"), String(stdout));
    await writeArtifact(path.join(artifactDir, "codex-stderr.log"), String(stderr));
  } catch (error) {
    await writeArtifact(path.join(artifactDir, "codex-error.log"), formatExecError(error));
    return await blockedImplementerResult({
      artifactDir,
      summary: "Codex fallo o excedio timeout. El worktree queda para inspeccion.",
      blockedReason: formatExecError(error),
      worktreePath,
      branchName,
    });
  }

  const statusAfter = (await runGit(["status", "--porcelain"], worktreePath)).stdout;
  const changedFiles = (await runGit(["diff", "--name-only"], worktreePath)).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const diffStat = (await runGit(["diff", "--stat"], worktreePath)).stdout.trim();
  const diffPatch = (await runGit(["diff", "--binary"], worktreePath, { timeout: 120_000 })).stdout;
  await writeArtifact(path.join(artifactDir, "git-status-after.txt"), statusAfter);
  await writeArtifact(path.join(artifactDir, "changed-files.txt"), changedFiles.join("\n") + "\n");
  await writeArtifact(path.join(artifactDir, "diff-stat.txt"), diffStat + "\n");
  await writeArtifact(path.join(artifactDir, "diff.patch"), diffPatch);

  const deniedRoots = project.deniedRoots ?? DEFAULT_PROJECTS[project.projectId]?.deniedRoots ?? [];
  const scopeViolation = findScopeViolation(changedFiles, project.allowedRoots, deniedRoots);
  if (scopeViolation) {
    return await blockedImplementerResult({
      artifactDir,
      summary: "Codex produjo cambios fuera de scope. El worktree queda para inspeccion.",
      blockedReason: scopeViolation,
      worktreePath,
      branchName,
      changedFiles,
      diffStat,
    });
  }

  const tests: ImplementerTestResult[] = [];
  for (const command of project.tests ?? []) {
    const safeName = crypto.createHash("sha1").update(command).digest("hex").slice(0, 10);
    const logPath = path.join(artifactDir, "test-" + safeName + ".log");
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
        cwd: worktreePath,
        timeout: project.codexTimeoutMs ?? CODEX_IMPLEMENTER_TIMEOUT_MS,
        maxBuffer: IMPLEMENTER_MAX_BUFFER,
      });
      await writeArtifact(logPath, String(stdout) + String(stderr));
      tests.push({ command, status: "passed", logPath });
    } catch (error) {
      await writeArtifact(logPath, formatExecError(error));
      tests.push({ command, status: "failed", logPath });
      return await blockedImplementerResult({
        artifactDir,
        summary: "Un test configurado fallo. El worktree queda para inspeccion.",
        blockedReason: "test failed: " + command,
        worktreePath,
        branchName,
        changedFiles,
        diffStat,
        tests,
      });
    }
  }

  const result = {
    status: "completed",
    workflowId: workflow.workflowId,
    projectId: project.projectId,
    branchName,
    worktreePath,
    changedFiles,
    diffStat,
    tests,
  };
  await writeArtifact(
    path.join(artifactDir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return {
    status: "completed",
    summary: "Codex aplico cambios en worktree controlado. No deploy, no merge, no push.",
    artifactDir,
    worktreePath,
    branchName,
    changedFiles,
    diffStat,
    tests,
  };
}

function parseReviewerResult(stdout: string): Pick<ReviewerResult, "status" | "recommendation"> {
  const normalized = stdout
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const resultMatch = /^resultado:\s*(pass|fail)\s*$/im.exec(normalized);
  const recommendationMatch = /^recomendacion final:\s*-?\s*(aprobar|corregir)/im.exec(normalized);
  return {
    status: resultMatch?.[1] === "pass" ? "passed" : "failed",
    recommendation: recommendationMatch?.[1] === "aprobar" ? "aprobar" : "corregir",
  };
}

function buildReviewerPrompt(params: {
  workflow: ProjectWorkflowRecord;
  project: ResolvedProjectWorkflowProjectConfig;
  implementerResult: ImplementerResult;
  statusBefore: string;
  diffBefore: string;
}): string {
  const { workflow, project, implementerResult, statusBefore, diffBefore } = params;
  return [
    "Actua como Reviewer real clean-room dentro de OpenClaw ProjectWorkflow Fase 2.",
    "Modo read-only estricto: no editar archivos, no ejecutar fixes, no aplicar parches, no formatear, no instalar, no commitear.",
    "Tu tarea es revisar evidencia objetiva y reportar PASS o FAIL. Si necesitas cambios, reporta FAIL; no los apliques.",
    "No reutilices contexto del implementer. No asumas evidencia que no este incluida aqui.",
    "",
    "Formato obligatorio:",
    "RESULTADO: PASS | FAIL",
    "",
    "HALLAZGOS:",
    "- ...",
    "",
    "RIESGOS:",
    "- ...",
    "",
    "TESTS VERIFICADOS:",
    "- ...",
    "",
    "CRITERIOS DE ACEPTACION:",
    "- [ok/fail] ...",
    "",
    "RECOMENDACION FINAL:",
    "- aprobar / corregir antes de cerrar",
    "",
    "EVIDENCIA OBJETIVA",
    "Proyecto: " + project.projectId,
    "repoPath: " + project.repoPath,
    "worktreePath: " + (implementerResult.worktreePath ?? "no registrado"),
    "branch: " + (implementerResult.branchName ?? "no registrada"),
    "artifacts: " + implementerResult.artifactDir,
    "",
    "Request original:",
    workflow.goal,
    "",
    "Proposal aprobada del Architect:",
    workflow.artifacts.architectProposal ?? "",
    "",
    "Archivos modificados:",
    implementerResult.changedFiles.length
      ? implementerResult.changedFiles.map((file) => "- " + file).join("\n")
      : "- ninguno",
    "",
    "Comandos ejecutados por implementer / tests:",
    implementerResult.tests.length
      ? implementerResult.tests.map((test) => "- " + test.command + " => " + test.status).join("\n")
      : "- no configurados",
    "",
    "Resultado tests:",
    JSON.stringify(implementerResult.tests, null, 2),
    "",
    "git status antes del review:",
    statusBefore || "clean",
    "",
    "git diff antes del review:",
    diffBefore || "sin diff",
  ].join("\n");
}

async function defaultReviewerRunner(params: {
  workflow: ProjectWorkflowRecord;
  project: ResolvedProjectWorkflowProjectConfig;
  implementerResult: ImplementerResult;
}): Promise<ReviewerResult> {
  const { workflow, project, implementerResult } = params;
  const reviewerConfig = project.reviewer;
  const artifactDir = implementerResult.artifactDir;
  if (reviewerConfig?.enabled !== true) {
    return {
      status: "simulated",
      summary:
        "Reviewer simulado: no ejecuto revision semantica real. Pendiente de revision humana.",
      recommendation: "corregir",
      artifactDir,
    };
  }

  if (!implementerResult.worktreePath) {
    return {
      status: "blocked",
      summary: "Reviewer real no pudo ejecutarse: falta worktreePath del implementer.",
      blockedReason: "missing implementer worktreePath",
      artifactDir,
    };
  }

  const statusBefore = (await runGit(["status", "--porcelain"], implementerResult.worktreePath))
    .stdout;
  const diffBefore = (
    await runGit(["diff", "--binary"], implementerResult.worktreePath, { timeout: 120_000 })
  ).stdout;
  const statusBeforePath = path.join(artifactDir, "review-git-status-before.txt");
  const diffBeforePath = path.join(artifactDir, "review-diff-before.patch");
  await writeArtifact(statusBeforePath, statusBefore);
  await writeArtifact(diffBeforePath, diffBefore);

  const prompt = buildReviewerPrompt({
    workflow,
    project,
    implementerResult,
    statusBefore,
    diffBefore,
  });
  await writeArtifact(path.join(artifactDir, "reviewer-prompt.md"), prompt);

  const stdoutPath = path.join(artifactDir, "reviewer-stdout.log");
  const stderrPath = path.join(artifactDir, "reviewer-stderr.log");
  let stdout = "";
  try {
    const codexCli =
      reviewerConfig.codexCli ?? process.env.OPENCLAW_PROJECT_WORKFLOW_CODEX_CLI ?? "codex";
    const result = await execFileAsync(
      codexCli,
      [
        "exec",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--ignore-rules",
        "--cd",
        implementerResult.worktreePath,
        prompt,
      ],
      {
        cwd: implementerResult.worktreePath,
        timeout: reviewerConfig.timeoutMs ?? CODEX_REVIEWER_TIMEOUT_MS,
        maxBuffer: IMPLEMENTER_MAX_BUFFER,
      },
    );
    stdout = String(result.stdout);
    await writeArtifact(stdoutPath, stdout);
    await writeArtifact(stderrPath, String(result.stderr));
  } catch (error) {
    const message = formatExecError(error);
    await writeArtifact(
      stdoutPath,
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "",
    );
    await writeArtifact(stderrPath, message);
    return {
      status: "failed",
      summary: "Reviewer real fallo o excedio timeout.",
      recommendation: "corregir",
      artifactDir,
      stdoutPath,
      stderrPath,
      gitStatusBeforePath: statusBeforePath,
      diffBeforePath,
      blockedReason: message,
    };
  }

  const statusAfter = (await runGit(["status", "--porcelain"], implementerResult.worktreePath))
    .stdout;
  const diffAfter = (
    await runGit(["diff", "--binary"], implementerResult.worktreePath, { timeout: 120_000 })
  ).stdout;
  const statusAfterPath = path.join(artifactDir, "review-git-status-after.txt");
  const diffAfterPath = path.join(artifactDir, "review-diff-after.patch");
  await writeArtifact(statusAfterPath, statusAfter);
  await writeArtifact(diffAfterPath, diffAfter);

  if (statusAfter !== statusBefore || diffAfter !== diffBefore) {
    return {
      status: "blocked",
      summary: "Reviewer real dejo cambios en el worktree; revision invalidada.",
      recommendation: "corregir",
      artifactDir,
      stdoutPath,
      stderrPath,
      gitStatusBeforePath: statusBeforePath,
      gitStatusAfterPath: statusAfterPath,
      diffBeforePath,
      diffAfterPath,
      blockedReason: "reviewer changed worktree status or diff",
    };
  }

  const parsed = parseReviewerResult(stdout);
  return {
    status: parsed.status,
    summary: stdout.trim() || "Reviewer real no produjo salida parseable.",
    recommendation: parsed.recommendation,
    artifactDir,
    stdoutPath,
    stderrPath,
    gitStatusBeforePath: statusBeforePath,
    gitStatusAfterPath: statusAfterPath,
    diffBeforePath,
    diffAfterPath,
    blockedReason:
      parsed.status === "failed" ? "reviewer reported FAIL or unparseable result" : undefined,
  };
}

async function defaultArchitectureReviewerRunner(params: {
  workflow: ProjectWorkflowRecord;
  project: ResolvedProjectWorkflowProjectConfig;
  implementerResult: ImplementerResult;
}): Promise<ReviewerResult> {
  if (params.project.architectureReviewer?.enabled !== true) {
    return {
      status: "skipped",
      summary: "Architecture Reviewer no configurado para este proyecto.",
      artifactDir: params.implementerResult.artifactDir,
    };
  }
  return await defaultReviewerRunner({
    ...params,
    project: {
      ...params.project,
      reviewer: params.project.architectureReviewer,
    },
  });
}

function applyImplementerResult(
  workflow: ProjectWorkflowRecord,
  result: ImplementerResult,
  at: string,
): void {
  workflow.artifacts.implementationSummary = result.summary;
  workflow.artifacts.implementerStatus = result.status;
  workflow.artifacts.blockedReason = result.blockedReason;
  workflow.artifacts.worktreePath = result.worktreePath;
  workflow.artifacts.branchName = result.branchName;
  workflow.artifacts.artifactDir = result.artifactDir;
  workflow.artifacts.changedFiles = result.changedFiles;
  workflow.artifacts.diffStat = result.diffStat;
  workflow.artifacts.tests = result.tests;
  workflow.updatedAt = at;

  appendAudit(workflow, "approved_for_implementation", "Aprobacion humana registrada.", at);
  appendAudit(
    workflow,
    "implementer_running",
    "Codex Implementer real ejecutado en worktree controlado.",
    at,
  );

  if (result.status === "blocked") {
    workflow.status = "blocked";
    workflow.phase = "result";
    workflow.currentCapability = "implementer";
    appendAudit(workflow, "blocked", result.blockedReason ?? "Implementer bloqueado.", at);
    return;
  }

  workflow.status = "reviewer_running";
  workflow.phase = "reviewer";
  workflow.currentCapability = "reviewer";
}

function applyReviewerArtifacts(
  workflow: ProjectWorkflowRecord,
  result: ReviewerResult,
  at: string,
): void {
  workflow.artifacts.reviewSummary = result.summary;
  workflow.artifacts.reviewStatus = result.status;
  workflow.artifacts.reviewRecommendation = result.recommendation;
  workflow.artifacts.reviewFindings = result.findings;
  workflow.artifacts.reviewRisks = result.risks;
  workflow.artifacts.reviewStdoutPath = result.stdoutPath;
  workflow.artifacts.reviewStderrPath = result.stderrPath;
  workflow.artifacts.reviewGitStatusBeforePath = result.gitStatusBeforePath;
  workflow.artifacts.reviewGitStatusAfterPath = result.gitStatusAfterPath;
  workflow.artifacts.reviewDiffBeforePath = result.diffBeforePath;
  workflow.artifacts.reviewDiffAfterPath = result.diffAfterPath;
  workflow.updatedAt = at;
}

function applyArchitectureReviewArtifacts(
  workflow: ProjectWorkflowRecord,
  result: ReviewerResult,
  at: string,
): void {
  workflow.artifacts.architectureReviewSummary = result.summary;
  workflow.artifacts.architectureReviewStatus = result.status;
  workflow.artifacts.architectureReviewRecommendation = result.recommendation;
  workflow.artifacts.architectureReviewStdoutPath = result.stdoutPath;
  workflow.artifacts.architectureReviewStderrPath = result.stderrPath;
  workflow.artifacts.architectureReviewGitStatusBeforePath = result.gitStatusBeforePath;
  workflow.artifacts.architectureReviewGitStatusAfterPath = result.gitStatusAfterPath;
  workflow.artifacts.architectureReviewDiffBeforePath = result.diffBeforePath;
  workflow.artifacts.architectureReviewDiffAfterPath = result.diffAfterPath;
  workflow.updatedAt = at;
}

function isReviewFailure(result: ReviewerResult): boolean {
  return result.status === "failed" || result.status === "blocked";
}

function appendReviewAudit(
  workflow: ProjectWorkflowRecord,
  status: ProjectWorkflowStatus,
  note: string,
  at: string,
): void {
  appendAudit(workflow, status, note, at);
}

function finalizeReviewPolicy(params: {
  workflow: ProjectWorkflowRecord;
  technicalReview: ReviewerResult;
  architectureReview: ReviewerResult;
  mode: ReviewMode;
  at: string;
}): void {
  const { workflow, technicalReview, architectureReview, mode, at } = params;
  workflow.artifacts.reviewMode = mode;
  workflow.phase = "result";
  workflow.currentCapability = "reviewer";

  appendReviewAudit(
    workflow,
    "reviewer_running",
    "Technical Reviewer ejecutado despues del implementer.",
    at,
  );
  if (technicalReview.status === "passed" || technicalReview.status === "simulated") {
    appendReviewAudit(
      workflow,
      "review_passed",
      "Technical Reviewer aprobo o quedo simulado por configuracion.",
      at,
    );
  } else {
    appendReviewAudit(
      workflow,
      "review_failed",
      technicalReview.blockedReason ?? "Technical Reviewer reporto FAIL.",
      at,
    );
  }

  if (architectureReview.status !== "skipped") {
    if (architectureReview.status === "passed" || architectureReview.status === "simulated") {
      appendReviewAudit(workflow, "review_passed", "Architecture Reviewer aprobo.", at);
    } else {
      appendReviewAudit(
        workflow,
        "architecture_review_failed",
        architectureReview.blockedReason ?? "Architecture Reviewer reporto FAIL.",
        at,
      );
    }
  }

  if (technicalReview.status === "blocked") {
    workflow.status = "blocked";
    workflow.artifacts.blockedReason = technicalReview.blockedReason ?? technicalReview.summary;
    appendReviewAudit(
      workflow,
      "blocked",
      technicalReview.blockedReason ?? "Technical Reviewer bloqueado.",
      at,
    );
    return;
  }
  if (architectureReview.status === "blocked") {
    workflow.status = "blocked";
    workflow.artifacts.blockedReason =
      architectureReview.blockedReason ?? architectureReview.summary;
    appendReviewAudit(
      workflow,
      "blocked",
      architectureReview.blockedReason ?? "Architecture Reviewer bloqueado.",
      at,
    );
    return;
  }

  const technicalFailed = technicalReview.status === "failed";
  const architectureFailed = architectureReview.status === "failed";

  if (mode === "advisory") {
    if (technicalFailed || architectureFailed) {
      workflow.status = "completed_with_warnings";
      appendReviewAudit(
        workflow,
        "completed_with_warnings",
        "Workflow completado con observaciones de review advisory.",
        at,
      );
      return;
    }
    workflow.status = "completed";
    appendReviewAudit(
      workflow,
      "completed",
      "Workflow completado con reviews advisory sin observaciones bloqueantes.",
      at,
    );
    return;
  }

  if (technicalFailed) {
    workflow.status = "review_failed";
    return;
  }
  if (architectureFailed) {
    workflow.status = "architecture_review_failed";
    return;
  }
  workflow.status = "completed";
  appendReviewAudit(workflow, "completed", "Workflow implementado en worktree controlado.", at);
}

function formatWorkflowHeader(workflow: ProjectWorkflowRecord): string {
  return [
    "[Workflow]",
    `workflow_id=${workflow.workflowId}`,
    `phase=${workflow.status}`,
    `project=${workflow.projectId}`,
  ].join("\n");
}

function formatArchitectQueuedReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: [
      formatWorkflowHeader(workflow),
      "",
      "Recibi el pedido. El Architect esta analizando.",
      "Te aviso cuando tenga una propuesta para aprobar.",
    ].join("\n"),
  };
}

function formatArchitectFailedReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: [
      formatWorkflowHeader(workflow),
      "",
      workflow.artifacts.architectError ?? "Project Workflow Architect failed.",
    ].join("\n"),
  };
}

function formatApprovalReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: `${formatWorkflowHeader(workflow)}\n\nArchitect (Claude):\n${
      workflow.artifacts.architectProposal ?? "Propuesta generada."
    }\n\n¿Aprobar?\n\nComandos: aprobar | rechazar | cancelar | estado`,
  };
}

function formatStatusReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  const lastEvent = workflow.auditLog.at(-1);
  return {
    text: `${formatWorkflowHeader(workflow)}\n\nGoal:\n${workflow.goal}\n\nUltimo evento: ${
      lastEvent?.note ?? "sin eventos"
    }\n\nModo: architect-real / implementer-real-controlado / reviewer-simulado`,
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

function formatTests(tests: { command: string; status: string }[] | undefined): string {
  if (!tests?.length) {
    return "- no configurados";
  }
  return tests.map((test) => "- " + test.command + " " + test.status.toUpperCase()).join("\n");
}

function formatChangedFiles(files: string[] | undefined): string {
  if (!files?.length) {
    return "- sin cambios registrados";
  }
  return files.map((file) => "- " + file).join("\n");
}

function formatReviewStatusLine(label: string, status: string | undefined): string {
  if (status === "passed") {
    return label + ": PASS";
  }
  if (status === "failed") {
    return label + ": FAIL";
  }
  if (status === "blocked") {
    return label + ": BLOCKED";
  }
  if (status === "skipped") {
    return label + ": SKIPPED";
  }
  return label + ": simulado";
}

function formatCompletedReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: [
      formatWorkflowHeader(workflow),
      "",
      "Implementer (Codex real):",
      workflow.artifacts.implementationSummary ?? "Implementacion finalizada.",
      "",
      "Archivos modificados:",
      formatChangedFiles(workflow.artifacts.changedFiles),
      "",
      "Tests ejecutados:",
      formatTests(workflow.artifacts.tests),
      "",
      "Artifacts:",
      workflow.artifacts.artifactDir ?? "no registrado",
      "",
      "Worktree:",
      workflow.artifacts.worktreePath ?? "no registrado",
      "Branch:",
      workflow.artifacts.branchName ?? "no registrada",
      "",
      formatReviewStatusLine("Technical Reviewer", workflow.artifacts.reviewStatus),
      workflow.artifacts.reviewSummary ??
        "Reviewer simulado: no ejecuto revision semantica real. Pendiente de revision humana.",
      "",
      formatReviewStatusLine("Architecture Reviewer", workflow.artifacts.architectureReviewStatus),
      workflow.artifacts.architectureReviewSummary ?? "Architecture Reviewer no configurado.",
    ].join("\n"),
  };
}

function formatBlockedReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: [
      formatWorkflowHeader(workflow),
      "",
      "Implementer (Codex real): BLOCKED",
      workflow.artifacts.implementationSummary ?? "Implementacion bloqueada.",
      "",
      "Motivo:",
      workflow.artifacts.blockedReason ?? "no especificado",
      "",
      "Archivos modificados:",
      formatChangedFiles(workflow.artifacts.changedFiles),
      "",
      "Tests ejecutados:",
      formatTests(workflow.artifacts.tests),
      "",
      "Artifacts:",
      workflow.artifacts.artifactDir ?? "no registrado",
      "",
      "Worktree:",
      workflow.artifacts.worktreePath ?? "no creado",
      "Branch:",
      workflow.artifacts.branchName ?? "no creada",
      "",
      "Reviewer simulado: no se ejecuto porque el workflow quedo bloqueado.",
    ].join("\n"),
  };
}

function formatReviewFailedReply(workflow: ProjectWorkflowRecord): ReplyPayload {
  return {
    text: [
      formatWorkflowHeader(workflow),
      "",
      workflow.status === "architecture_review_failed"
        ? "Architecture Reviewer: FAIL"
        : "Technical Reviewer: FAIL",
      workflow.status === "architecture_review_failed"
        ? (workflow.artifacts.architectureReviewSummary ?? "Architecture Reviewer reporto FAIL.")
        : (workflow.artifacts.reviewSummary ?? "Reviewer real reporto FAIL."),
      "",
      "Recomendacion:",
      workflow.artifacts.reviewRecommendation ?? "corregir",
      "",
      "Artifacts:",
      workflow.artifacts.artifactDir ?? "no registrado",
      "",
      "Stdout:",
      workflow.artifacts.reviewStdoutPath ?? "no registrado",
      "Stderr:",
      workflow.artifacts.reviewStderrPath ?? "no registrado",
    ].join("\n"),
  };
}

function formatTerminalReply(workflow: ProjectWorkflowRecord, label: string): ReplyPayload {
  return {
    text: `${formatWorkflowHeader(workflow)}\n\n${label}\n\nModo: architect-real / implementer-real-controlado / reviewer-simulado`,
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

export type ProjectWorkflowQueueResult = {
  processed: number;
  replies: ReplyPayload[];
};

export async function processProjectWorkflowQueue(
  cfg: OpenClawConfig,
  opts: ProjectWorkflowRuntimeOptions = {},
): Promise<ProjectWorkflowQueueResult> {
  if (cfg.project_workflows_enabled !== true) {
    return { processed: 0, replies: [] };
  }
  const storePath = opts.storePath ?? resolveProjectWorkflowStorePath();
  const nowFactory = opts.now ?? (() => new Date());
  const architectRunner = opts.architectRunner ?? runClaudeArchitect;
  const replies: ReplyPayload[] = [];
  let processed = 0;

  while (true) {
    const claim = await updateProjectWorkflowStore((store) => {
      const queued = store.workflows
        .filter((workflow) => workflow.status === "architect_queued")
        .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!queued) {
        return undefined;
      }
      const at = nowFactory().toISOString();
      queued.status = "architect_running";
      queued.phase = "architect";
      queued.currentCapability = "architect";
      queued.updatedAt = at;
      appendAudit(queued, "architect_running", "Architect async iniciado.", at);
      return { workflowId: queued.workflowId, goal: queued.goal, projectId: queued.projectId };
    }, storePath);

    if (!claim) {
      break;
    }

    processed += 1;
    const timeoutMs = resolveClaudeArchitectTimeoutMs();
    try {
      const proposal = await architectRunner({
        goal: claim.goal,
        projectId: claim.projectId,
        timeoutMs,
      });
      const reply = await updateProjectWorkflowStore((store) => {
        const workflow = store.workflows.find(
          (candidate) =>
            candidate.workflowId === claim.workflowId && candidate.status === "architect_running",
        );
        if (!workflow) {
          return undefined;
        }
        completeArchitectProposal(workflow, proposal, nowFactory().toISOString());
        return formatApprovalReply(workflow);
      }, storePath);
      if (reply) {
        replies.push(reply);
      }
    } catch (error) {
      const message = isTimeoutError(error)
        ? formatArchitectTimeoutMessage(timeoutMs)
        : "Project Workflow Architect failed: " + formatExecError(error);
      const reply = await updateProjectWorkflowStore((store) => {
        const workflow = store.workflows.find(
          (candidate) =>
            candidate.workflowId === claim.workflowId && candidate.status === "architect_running",
        );
        if (!workflow) {
          return undefined;
        }
        failArchitect(workflow, message, nowFactory().toISOString());
        return formatArchitectFailedReply(workflow);
      }, storePath);
      if (reply) {
        replies.push(reply);
      }
    }
  }

  return { processed, replies };
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
  const pilot = route ? resolvePilot(cfg, route) : null;
  if ((normalizeRouteField(ctx.Surface) ?? normalizeRouteField(ctx.Provider)) === "telegram") {
    const parts = getTelegramRouteParts(ctx);
    console.info(
      "[ProjectWorkflow] route chatId=" +
        (parts.chatId ?? "missing") +
        " topicId=" +
        (parts.topicId ?? "missing") +
        " pilotMatch=" +
        (pilot ? "yes" : "no"),
    );
  }
  if (!route || !pilot) {
    return undefined;
  }

  const text = normalizeCommandText(ctx);
  const command = classifyCommand(text);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const workflowId =
    opts.idFactory?.() ?? `pwf_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const storePath = opts.storePath ?? resolveProjectWorkflowStorePath();

  return await updateProjectWorkflowStore(async (store) => {
    const active = findActiveWorkflow(store.workflows, route);

    if (!active) {
      if (command === "status") {
        return formatNoActiveWorkflowReply(route, pilot.projectId);
      }
      if (command === "approve" || command === "reject" || command === "cancel") {
        return formatNoActiveWorkflowReply(route, pilot.projectId);
      }
      const workflow = createQueuedWorkflow({
        workflowId,
        projectId: pilot.projectId,
        route,
        goal: text || "Goal sin texto",
        at: now,
      });
      store.workflows.push(workflow);
      return formatArchitectQueuedReply(workflow);
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
      if (active.status !== "awaiting_human_approval") {
        return formatStatusReply(active);
      }
      const project = resolveProjectConfig(cfg, active.projectId);
      if (!project) {
        applyImplementerResult(
          active,
          {
            status: "blocked",
            summary: "No hay configuracion de proyecto para ejecutar Implementer.",
            blockedReason: "missing project_workflows.projects entry for " + active.projectId,
            artifactDir: defaultArtifactRoot(active.workflowId),
            changedFiles: [],
            tests: [],
          },
          now,
        );
        return formatBlockedReply(active);
      }
      const result = await (opts.implementerRunner ?? runCodexImplementer)({
        workflow: active,
        project,
      });
      applyImplementerResult(active, result, now);
      if (result.status === "blocked") {
        return formatBlockedReply(active);
      }
      const review = await (opts.reviewerRunner ?? defaultReviewerRunner)({
        workflow: active,
        project,
        implementerResult: result,
      });
      const architectureReview = await (
        opts.architectureReviewerRunner ?? defaultArchitectureReviewerRunner
      )({
        workflow: active,
        project,
        implementerResult: result,
      });
      applyReviewerArtifacts(active, review, now);
      applyArchitectureReviewArtifacts(active, architectureReview, now);
      finalizeReviewPolicy({
        workflow: active,
        technicalReview: review,
        architectureReview,
        mode: resolveReviewMode(project),
        at: now,
      });
      return active.status === "blocked"
        ? formatBlockedReply(active)
        : active.status === "review_failed" || active.status === "architecture_review_failed"
          ? formatReviewFailedReply(active)
          : formatCompletedReply(active);
    }

    const workflow = createQueuedWorkflow({
      workflowId,
      projectId: pilot.projectId,
      route,
      goal: text || "Goal sin texto",
      at: now,
    });
    store.workflows.push(workflow);
    return formatArchitectQueuedReply(workflow);
  }, storePath);
}
