import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => numeric(name, { precision: 12, scale: 6, mode: "number" });

export const goalStatus = pgEnum("goal_status", [
  "INTERPRETING",
  "NEEDS_INPUT",
  "PLANNING",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);
export const taskStatus = pgEnum("task_status", [
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
]);
export const riskLevel = pgEnum("risk_level", ["LOW", "MEDIUM", "HIGH"]);
export const verificationStatus = pgEnum("verification_status", ["PENDING", "PASSED", "FAILED", "SKIPPED"]);
export const approvalStatus = pgEnum("approval_status", ["PENDING", "APPROVED", "REJECTED", "EXPIRED"]);
export const approvalKind = pgEnum("approval_kind", ["TASK", "TOOL_CALL"]);
export const runStatus = pgEnum("run_status", ["RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "INTERRUPTED"]);
export const toolCallStatus = pgEnum("tool_call_status", [
  "PENDING_APPROVAL",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
]);
export const memoryCategory = pgEnum("memory_category", [
  "USER",
  "PROJECT",
  "PREFERENCE",
  "DECISION",
  "DOCUMENT",
  "ACTION",
  "RESULT",
]);
export const recommendationStatus = pgEnum("recommendation_status", ["PENDING", "APPROVED", "DISMISSED"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the cookie token; the raw token never touches the database.
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "member">().notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("workspace_members_user_idx").on(t.userId)],
);

export type GoalInterpretation = {
  objective: string;
  constraints: string[];
  target: string | null;
  deadline: string | null;
  knownContext: string[];
  missingInformation: { question: string; why: string; critical: boolean }[];
};
export type Clarification = { question: string; answer: string };

export const goals = pgTable(
  "goals",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id),
    prompt: text("prompt").notNull(),
    objective: text("objective"),
    interpretation: jsonb("interpretation").$type<GoalInterpretation>(),
    clarifications: jsonb("clarifications").$type<Clarification[]>().notNull().default([]),
    status: goalStatus("status").notNull().default("INTERPRETING"),
    budgetUsd: money("budget_usd").notNull(),
    costUsd: money("cost_usd").notNull().default(0),
    replanCount: integer("replan_count").notNull().default(0),
    error: text("error"),
    // Execution lease: only the holder may advance the goal. Expiry makes crashed runs resumable.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("goals_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("goals_status_idx").on(t.status),
  ],
);

export const goalRequirements = pgTable(
  "goal_requirements",
  {
    id: id(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("goal_requirements_goal_idx").on(t.goalId)],
);

export type TaskInput = {
  acceptanceCriteria: string;
  deliverable: boolean;
  /** Feedback from a failed verification, fed to the next attempt. */
  repairFeedback?: string[];
  /** Times this task has waited out a provider rate limit (does not consume retries). */
  rateLimitWaits?: number;
  /** Set once a task-level approval has been granted. */
  approved?: boolean;
};
export type VerificationReport = {
  verdict: "PASS" | "FAIL";
  score: number;
  checks: { name: string; passed: boolean; detail: string }[];
  issues: string[];
  verifiedBy: "deterministic" | "deterministic+agent";
};
export type TaskOutput = { text: string; documentId?: string; summary?: string };

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: taskStatus("status").notNull().default("PENDING"),
    priority: integer("priority").notNull().default(3),
    assignedAgent: text("assigned_agent"),
    requiredTools: jsonb("required_tools").$type<string[]>().notNull().default([]),
    input: jsonb("input").$type<TaskInput>().notNull(),
    output: jsonb("output").$type<TaskOutput>(),
    riskLevel: riskLevel("risk_level").notNull().default("LOW"),
    approvalRequired: boolean("approval_required").notNull().default(false),
    verificationStatus: verificationStatus("verification_status").notNull().default("PENDING"),
    verification: jsonb("verification").$type<VerificationReport>(),
    retryCount: integer("retry_count").notNull().default(0),
    error: text("error"),
    costUsd: money("cost_usd").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_goal_status_idx").on(t.goalId, t.status),
    uniqueIndex("tasks_goal_key_idx").on(t.goalId, t.key),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }), index("task_deps_depends_on_idx").on(t.dependsOnTaskId)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: runStatus("status").notNull().default("RUNNING"),
    // Serialized conversation so a paused/crashed run resumes where it stopped.
    state: jsonb("state").$type<unknown>(),
    iterations: integer("iterations").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: money("cost_usd").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_task_idx").on(t.taskId), index("agent_runs_goal_idx").on(t.goalId)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: id(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    providerCallId: text("provider_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    output: jsonb("output").$type<unknown>(),
    status: toolCallStatus("status").notNull(),
    riskLevel: riskLevel("risk_level").notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tool_calls_task_idx").on(t.taskId),
    uniqueIndex("tool_calls_run_call_idx").on(t.agentRunId, t.providerCallId),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "cascade" }),
    kind: approvalKind("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<unknown>(),
    riskLevel: riskLevel("risk_level").notNull(),
    status: approvalStatus("status").notNull().default("PENDING"),
    decidedById: uuid("decided_by_id").references(() => users.id),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_workspace_status_idx").on(t.workspaceId, t.status),
    index("approvals_goal_idx").on(t.goalId),
    index("approvals_task_idx").on(t.taskId),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Set for USER / PREFERENCE memories: private to that user.
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    category: memoryCategory("category").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: text("source").$type<"user" | "system" | "agent">().notNull().default("user"),
    sourceGoalId: uuid("source_goal_id").references(() => goals.id, { onDelete: "set null" }),
    sourceTaskId: uuid("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("memories_workspace_category_idx").on(t.workspaceId, t.category, t.updatedAt)],
);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("deliverable"),
    mimeType: text("mime_type").notNull().default("text/markdown"),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("documents_goal_idx").on(t.goalId), index("documents_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const executionEvents = pgTable(
  "execution_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    level: text("level").$type<"info" | "warn" | "error">().notNull().default("info"),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("execution_events_goal_idx").on(t.goalId, t.id)],
);

export type ResultStats = {
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksBlocked: number;
  tasksCancelled: number;
  executionMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  retries: number;
};

export const results = pgTable(
  "results",
  {
    id: id(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    statusLabel: text("status_label").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    stats: jsonb("stats").$type<ResultStats>().notNull(),
    deliverables: jsonb("deliverables").$type<{ documentId: string; title: string }[]>().notNull().default([]),
    // False when the narrative could not be generated and only measured facts are shown.
    synthesized: boolean("synthesized").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("results_goal_idx").on(t.goalId, t.createdAt)],
);

export const learnings = pgTable(
  "learnings",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    resultId: uuid("result_id").references(() => results.id, { onDelete: "set null" }),
    observation: text("observation").notNull(),
    pattern: text("pattern").notNull(),
    confidence: real("confidence").notNull(),
    context: text("context").notNull(),
    recommendation: text("recommendation").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("learnings_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    resultId: uuid("result_id").references(() => results.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    actionPrompt: text("action_prompt").notNull(),
    status: recommendationStatus("status").notNull().default("PENDING"),
    decidedById: uuid("decided_by_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Set once the approved action has been compiled into tasks.
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("recommendations_goal_idx").on(t.goalId, t.createdAt)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: money("cost_usd").notNull().default(0),
    // False when the model has no known price and the fallback rate was used.
    priced: boolean("priced").notNull().default(true),
    durationMs: integer("duration_ms").notNull().default(0),
    success: boolean("success").notNull().default(true),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_workspace_idx").on(t.workspaceId, t.createdAt),
    index("usage_goal_idx").on(t.goalId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_workspace_idx").on(t.workspaceId, t.id)],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type ToolCall = typeof toolCalls.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ExecutionEvent = typeof executionEvents.$inferSelect;
export type Result = typeof results.$inferSelect;
export type Learning = typeof learnings.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type RiskLevel = (typeof riskLevel.enumValues)[number];
export type GoalStatus = (typeof goalStatus.enumValues)[number];
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type MemoryCategory = (typeof memoryCategory.enumValues)[number];
