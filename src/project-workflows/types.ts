export type ProjectWorkflowStatus =
  | "draft_goal"
  | "architect_running"
  | "awaiting_human_approval"
  | "approved_for_implementation"
  | "implementer_running"
  | "reviewer_running"
  | "completed"
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

export type ProjectWorkflowArtifact = {
  architectProposal?: string;
  implementationSummary?: string;
  reviewSummary?: string;
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
