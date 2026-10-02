import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { MeteredAI } from "@/ai";
import { AIError } from "@/ai";
import { assignAgent } from "@/agents/assign";
import { SPECIALISTS } from "@/agents/definitions";
import { getDb, schema } from "@/db";
import type { Goal, GoalInterpretation, Task } from "@/db/schema";
import { env } from "@/lib/env";
import { toolRegistry } from "@/tools/registry";
import { emit } from "./events";
import { normalizePlan, planSchema, type Plan } from "./plan";
import { classifyTask, taskNeedsUpfrontApproval } from "./risk";

function toolCatalog(): string {
  return toolRegistry
    .all()
    .map((t) => {
      const a = t.available();
      return a.ok
        ? `- ${t.name} [risk ${t.riskLevel}]: ${t.description}`
        : `- ${t.name}: NOT CONFIGURED (${a.reason}) - do not plan tasks that depend on it`;
    })
    .join("\n");
}

function agentCatalog(): string {
  return SPECIALISTS.map((a) => `- ${a.handles.join("/")}: ${a.name} - ${a.description}`).join("\n");
}

const SYSTEM = `You are the Goal Compiler of an AI workforce platform. You turn an interpreted goal into requirements and a dynamic task graph that specialist AI agents will execute.

Design the graph for THIS goal - different goals need different graphs. Principles:
- Each task is one coherent unit of work for one specialist, producing a concrete output.
- Use dependsOn to express real information flow. Independent tasks must NOT depend on each other so they can run in parallel.
- Task descriptions must be self-contained: the agent sees only the goal, its task, and the outputs of the tasks it depends on.
- Acceptance criteria must be concrete and checkable by a reviewer reading the output.
- Right-size the plan: a simple goal may need 2-4 tasks; a complex one more. Never pad.
- Task types: research, strategy, writing, creative, analytics, finance, marketing, action.
- Use type "action" ONLY for tasks that change something outside this platform via an available tool (e.g. sending email). Set riskLevel MEDIUM for external communications/publishing/modifying external systems and HIGH for financial, destructive or bulk/sensitive actions. Everything that only produces documents is LOW.
- http_request is only for real URLs the user supplied or that research will discover - it is NOT an integration with the user's CRM, email platform, ad accounts, CMS or deployment pipeline. Do not plan "action" tasks against systems that are not connected.
- Only list tools in requiredTools that are available. If the goal implies an external action that no available tool can perform (publishing a site, posting to social media, running ads), do NOT pretend: plan a task that produces the ready-to-use asset plus exact hand-off steps for the human.
- Never plan an external action that a COMPLETED task in this goal has already performed; build on its output instead.
- Agents cannot communicate with the user. Never plan tasks that draft, deliver, send or wait for questions to the user, or that "collect user input". Work from stated assumptions; anything only the user can supply will be asked for after the plan finishes.
- Respect the user's constraints, deadline and remembered preferences.
- End with whatever best completes the goal (for example a consolidated plan or launch checklist) - not with a generic "summary" task unless it adds value.`;

function goalBrief(goal: Pick<Goal, "prompt" | "clarifications">, interp: GoalInterpretation): string {
  const lines = [
    `Original request: ${goal.prompt}`,
    `Objective: ${interp.objective}`,
    interp.target ? `Target: ${interp.target}` : null,
    interp.deadline ? `Deadline: ${interp.deadline}` : null,
    interp.constraints.length ? `Constraints:\n${interp.constraints.map((c) => `- ${c}`).join("\n")}` : null,
    interp.knownContext.length ? `Known context:\n${interp.knownContext.map((c) => `- ${c}`).join("\n")}` : null,
    goal.clarifications.length
      ? `Clarifications from the user:\n${goal.clarifications.map((c) => `- ${c.question} -> ${c.answer}`).join("\n")}`
      : null,
    interp.missingInformation.length
      ? `Open questions (proceed on reasonable, explicitly stated assumptions):\n${interp.missingInformation.map((m) => `- ${m.question}`).join("\n")}`
      : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export { goalBrief };

type CompileInput = {
  goal: Goal;
  interpretation: GoalInterpretation;
  memory: string;
  /** Extra instruction, e.g. a follow-up action or a replan request. */
  directive?: string;
  existing?: Pick<Task, "key" | "title" | "status" | "type">[];
  keyPrefix?: string;
  maxTasks?: number;
  signal?: AbortSignal;
};

/** Ask the model for a plan, normalize it, and give it one chance to repair structural problems. */
export async function compilePlan(ai: MeteredAI, input: CompileInput): Promise<Plan> {
  const maxTasks = input.maxTasks ?? env().MAX_TASKS_PER_GOAL;
  const availableTools = toolRegistry.available().map((t) => t.name);
  const existingKeys = (input.existing ?? []).filter((t) => t.status === "COMPLETED").map((t) => t.key);

  const base = [
    `# Goal\n${goalBrief(input.goal, input.interpretation)}`,
    `# Specialists\n${agentCatalog()}`,
    `# Tools\n${toolCatalog()}`,
    `# Workspace memory\n${input.memory || "(empty)"}`,
    input.existing?.length
      ? `# Tasks already in this goal\n${input.existing.map((t) => `- ${t.key} [${t.status}] (${t.type}) ${t.title}`).join("\n")}\nNew tasks may depend on COMPLETED tasks by key. Do not repeat completed work.`
      : null,
    input.directive ? `# What to plan now\n${input.directive}` : null,
    `# Limits\nAt most ${maxTasks} tasks.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { object } = await ai.structured({
      system: SYSTEM,
      schema: planSchema,
      schemaName: "task_plan",
      maxTokens: 8000,
      signal: input.signal,
      messages: [{ role: "user", content: [{ type: "text", text: base + feedback }] }],
    });
    const { plan, issues } = normalizePlan(object, { maxTasks, availableTools, existingKeys, keyPrefix: input.keyPrefix });
    if (issues.length === 0) return plan;
    feedback = `\n\n# Your previous plan was invalid - fix these problems\n${issues.map((i) => `- ${i.message}`).join("\n")}`;
  }
  throw new AIError("The planner could not produce a valid task graph for this goal.", "invalid", ai.provider.id);
}

/**
 * Persist a normalized plan: the Manager assigns a specialist to each task, the Risk Engine
 * classifies it, and dependencies are stored as edges. Returns the created tasks.
 */
export async function persistPlan(goal: Goal, plan: Plan, opts: { parentTaskId?: string } = {}): Promise<Task[]> {
  const db = await getDb();
  const depKeys = [...new Set(plan.tasks.flatMap((t) => t.dependsOn))];

  const created = await db.transaction(async (tx) => {
    if (plan.requirements.length) {
      await tx.insert(schema.goalRequirements).values(
        plan.requirements.map((r, i) => ({ goalId: goal.id, title: r.title.slice(0, 200), description: r.description, position: i })),
      );
    }
    const rows = await tx
      .insert(schema.tasks)
      .values(
        plan.tasks.map((t) => {
          const { agent } = assignAgent({ type: t.type, requiredTools: t.requiredTools });
          const risk = classifyTask({
            type: t.type,
            title: t.title,
            description: t.description,
            declaredRisk: t.type === "action" ? t.riskLevel : "LOW",
            toolRisks: t.requiredTools.map((n) => toolRegistry.get(n)?.riskLevel ?? "LOW"),
          });
          return {
            goalId: goal.id,
            parentTaskId: opts.parentTaskId,
            key: t.key,
            type: t.type,
            title: t.title,
            description: t.description,
            priority: t.priority,
            assignedAgent: agent.id,
            requiredTools: t.requiredTools,
            input: { acceptanceCriteria: t.acceptanceCriteria, deliverable: t.deliverable },
            riskLevel: risk,
            approvalRequired: taskNeedsUpfrontApproval(risk),
          };
        }),
      )
      .returning();

    const existing = depKeys.length
      ? await tx
          .select({ id: schema.tasks.id, key: schema.tasks.key })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.goalId, goal.id), inArray(schema.tasks.key, depKeys)))
      : [];
    const idByKey = new Map([...existing, ...rows].map((r) => [r.key, r.id]));
    const edges = plan.tasks.flatMap((t) =>
      t.dependsOn
        .map((d) => ({ taskId: idByKey.get(t.key)!, dependsOnTaskId: idByKey.get(d) }))
        .filter((e): e is { taskId: string; dependsOnTaskId: string } => Boolean(e.dependsOnTaskId)),
    );
    if (edges.length) await tx.insert(schema.taskDependencies).values(edges);
    return rows;
  });

  for (const t of created) {
    const { reason } = assignAgent({ type: t.type, requiredTools: t.requiredTools });
    await emit({
      workspaceId: goal.workspaceId,
      goalId: goal.id,
      taskId: t.id,
      type: "agent.assigned",
      message: `Manager assigned "${t.title}" to ${t.assignedAgent} agent`,
      data: { agent: t.assignedAgent, reason, risk: t.riskLevel },
    });
  }
  return created;
}
