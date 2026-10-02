import type { TaskStatus } from "@/db/schema";

export type PlanNode = { key: string; dependsOn: string[] };

export type GraphIssue = { key?: string; message: string };

/** Structural validation of a planned task graph. Returns [] when the graph is a valid DAG. */
export function validateGraph(nodes: PlanNode[], maxTasks: number): GraphIssue[] {
  const issues: GraphIssue[] = [];
  if (nodes.length === 0) issues.push({ message: "Plan contains no tasks." });
  if (nodes.length > maxTasks) issues.push({ message: `Plan has ${nodes.length} tasks; the limit is ${maxTasks}.` });

  const keys = new Set<string>();
  for (const n of nodes) {
    if (keys.has(n.key)) issues.push({ key: n.key, message: `Duplicate task key "${n.key}".` });
    keys.add(n.key);
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (d === n.key) issues.push({ key: n.key, message: `Task "${n.key}" depends on itself.` });
      else if (!keys.has(d)) issues.push({ key: n.key, message: `Task "${n.key}" depends on unknown task "${d}".` });
    }
  }
  if (issues.length === 0 && topologicalOrder(nodes) === null) {
    issues.push({ message: "Task dependencies contain a cycle." });
  }
  return issues;
}

/** Kahn's algorithm. Returns keys in executable order, or null if there is a cycle. */
export function topologicalOrder(nodes: PlanNode[]): string[] | null {
  const indegree = new Map(nodes.map((n) => [n.key, 0]));
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of new Set(n.dependsOn)) {
      if (!indegree.has(d)) continue;
      indegree.set(n.key, (indegree.get(n.key) ?? 0) + 1);
      dependents.set(d, [...(dependents.get(d) ?? []), n.key]);
    }
  }
  const queue = nodes.filter((n) => indegree.get(n.key) === 0).map((n) => n.key);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const dep of dependents.get(k) ?? []) {
      const next = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
  }
  return order.length === nodes.length ? order : null;
}

export type TaskState = { id: string; status: TaskStatus; priority: number };
export type Edge = { taskId: string; dependsOnTaskId: string };

const DEAD: TaskStatus[] = ["FAILED", "BLOCKED", "CANCELLED"];

/**
 * Dependency resolution for one scheduling pass:
 *  - PENDING tasks whose dependencies are all COMPLETED become READY
 *  - PENDING tasks with a dependency that can never complete become BLOCKED
 * Blocking propagates transitively within the same pass.
 */
export function resolveTransitions(tasks: TaskState[], edges: Edge[]): { ready: string[]; blocked: string[] } {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const deps = new Map<string, string[]>();
  for (const e of edges) deps.set(e.taskId, [...(deps.get(e.taskId) ?? []), e.dependsOnTaskId]);

  const ready: string[] = [];
  const blocked: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (status.get(t.id) !== "PENDING") continue;
      const ds = (deps.get(t.id) ?? []).map((d) => status.get(d));
      if (ds.some((s) => s === undefined || DEAD.includes(s))) {
        status.set(t.id, "BLOCKED");
        blocked.push(t.id);
        changed = true;
      } else if (ds.every((s) => s === "COMPLETED")) {
        status.set(t.id, "READY");
        ready.push(t.id);
        changed = true;
      }
    }
  }
  return { ready, blocked };
}

/** Highest priority first (1 = most important), stable for equal priorities. */
export function pickBatch<T extends { priority: number }>(ready: T[], limit: number): T[] {
  return [...ready].sort((a, b) => a.priority - b.priority).slice(0, Math.max(0, limit));
}

export function progressPercent(tasks: { status: TaskStatus }[]): number {
  if (tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === "COMPLETED").length;
  return Math.round((done / tasks.length) * 100);
}
