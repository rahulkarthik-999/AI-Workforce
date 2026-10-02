import { z } from "zod";
import { TASK_TYPES } from "@/agents/definitions";
import { validateGraph, type GraphIssue } from "./graph";

export const planTaskSchema = z.object({
  key: z.string().describe("Short unique kebab-case id, e.g. market-research"),
  title: z.string(),
  description: z.string().describe("What to do and what to produce, self-contained"),
  type: z.enum(TASK_TYPES),
  dependsOn: z.array(z.string()).describe("Keys of tasks whose output this task needs"),
  requiredTools: z.array(z.string()).describe("Names of available tools this task must use; empty if none"),
  acceptanceCriteria: z.string().describe("Concrete, checkable conditions for the output to count as done"),
  priority: z.number().describe("1 (highest) to 5 (lowest)"),
  deliverable: z.boolean().describe("True if the output is something the user would want to keep"),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

export const planSchema = z.object({
  requirements: z.array(z.object({ title: z.string(), description: z.string() })),
  tasks: z.array(planTaskSchema),
});

export type PlanTask = z.infer<typeof planTaskSchema>;
export type Plan = z.infer<typeof planSchema>;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}

export type NormalizeOptions = {
  maxTasks: number;
  /** Tool names that exist and are configured; anything else is dropped from requiredTools. */
  availableTools: string[];
  /** Keys of tasks that already exist in the goal; new tasks may depend on them. */
  existingKeys?: string[];
  /** Prefix applied to new keys so follow-up / replan tasks never collide with existing ones. */
  keyPrefix?: string;
};

/**
 * Turns raw model output into a plan that is safe to persist: normalized keys, no unknown
 * tools, clamped priorities, and a dependency graph that is verified to be a DAG.
 * Model output is never trusted to be structurally valid.
 */
export function normalizePlan(raw: Plan, opts: NormalizeOptions): { plan: Plan; issues: GraphIssue[] } {
  const existing = new Set(opts.existingKeys ?? []);
  const prefix = opts.keyPrefix ?? "";
  const rename = new Map<string, string>();
  const used = new Set(existing);

  for (const t of raw.tasks) {
    const base = prefix + slug(t.key || t.title);
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
    used.add(key);
    // First definition wins if the model reused a key.
    if (!rename.has(t.key)) rename.set(t.key, key);
  }

  const seen = new Set<string>();
  const tasks: PlanTask[] = [];
  for (const t of raw.tasks) {
    const key = rename.get(t.key)!;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({
      ...t,
      key,
      title: t.title.trim().slice(0, 160),
      description: t.description.trim(),
      dependsOn: [...new Set(t.dependsOn.map((d) => rename.get(d) ?? d))],
      requiredTools: [...new Set(t.requiredTools.filter((n) => opts.availableTools.includes(n)))],
      priority: Math.min(5, Math.max(1, Math.round(t.priority) || 3)),
    });
  }

  const issues = validateGraph(
    [...tasks.map((t) => ({ key: t.key, dependsOn: t.dependsOn })), ...[...existing].map((key) => ({ key, dependsOn: [] }))],
    opts.maxTasks + existing.size,
  );
  if (tasks.length === 0) issues.push({ message: "Plan contains no tasks." });

  return { plan: { requirements: raw.requirements.slice(0, 12), tasks }, issues };
}
