export type ProjectWorkflowStatus =
  | "draft_goal"
  | "architect_running"
  | "awaiting_human_approval"
  | "approved_for_implementation"
  | "implementer_running"
  | "reviewer_running"
  | "review_passed"
  | "review_failed"
  | "architecture_review_failed"
  | "completed"
  | "completed_with_warnings"
  | "blocked"
  | "rejected"
  | "cancelled";

export type ProjectWorkflowPhase =
  | "goal"
  | "architect"
  | "approval"
  | "implementer"
  | "reviewer"
  | "result";

export type ProjectWorkflowRoute = {
  channel: "telegram";
  accountId: string;
  chatId: string;
  topicId: string;
};

export type ProjectWorkflowTestResult = {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  logPath?: string;
};

export type ProjectWorkflowArtifact = {
  architectProposal?: string;
  implementationSummary?: string;
  reviewMode?: "advisory" | "required";
  reviewSummary?: string;
  reviewStatus?: "passed" | "failed" | "blocked" | "simulated";
  reviewRecommendation?: "aprobar" | "corregir";
  reviewFindings?: string[];
  reviewRisks?: string[];
  reviewStdoutPath?: string;
  reviewStderrPath?: string;
  reviewGitStatusBeforePath?: string;
  reviewGitStatusAfterPath?: string;
  reviewDiffBeforePath?: string;
  reviewDiffAfterPath?: string;
  architectureReviewSummary?: string;
  architectureReviewStatus?: "passed" | "failed" | "blocked" | "simulated" | "skipped";
  architectureReviewRecommendation?: "aprobar" | "corregir";
  architectureReviewStdoutPath?: string;
  architectureReviewStderrPath?: string;
  architectureReviewGitStatusBeforePath?: string;
  architectureReviewGitStatusAfterPath?: string;
  architectureReviewDiffBeforePath?: string;
  architectureReviewDiffAfterPath?: string;
  implementerStatus?: "completed" | "blocked";
  blockedReason?: string;
  worktreePath?: string;
  branchName?: string;
  artifactDir?: string;
  changedFiles?: string[];
  diffStat?: string;
  tests?: ProjectWorkflowTestResult[];
};

export type ProjectWorkflowAuditEvent = {
  at: string;
  status: ProjectWorkflowStatus;
  note: string;
};

export type ProjectWorkflowRecord = {
  workflowId: string;
  projectId: string;
  route: ProjectWorkflowRoute;
  goal: string;
  status: ProjectWorkflowStatus;
  phase: ProjectWorkflowPhase;
  currentCapability?: "architect" | "implementer" | "reviewer";
  artifacts: ProjectWorkflowArtifact;
  auditLog: ProjectWorkflowAuditEvent[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectWorkflowStore = {
  version: 1;
  workflows: ProjectWorkflowRecord[];
};

export type ProjectWorkflowCommand = "approve" | "reject" | "cancel" | "status" | "goal";
