import { AGENTS, SPECIALISTS, type AgentDefinition, type AgentId } from "./definitions";

export type Assignable = { type: string; requiredTools: string[] };

/**
 * Manager routing: pick the specialist whose capabilities best cover the task.
 * Scoring is deterministic so assignments are explainable and testable:
 *   - handling the task type as a primary skill outweighs everything else
 *   - then coverage of the tools the task requires
 */
export function assignAgent(task: Assignable): { agent: AgentDefinition; reason: string } {
  let best: { agent: AgentDefinition; score: number; reason: string } | undefined;
  for (const agent of SPECIALISTS) {
    const typeIdx = agent.handles.indexOf(task.type as never);
    const typeScore = typeIdx === 0 ? 10 : typeIdx > 0 ? 6 : 0;
    const covered = task.requiredTools.filter((t) => agent.tools.includes(t));
    const toolScore = task.requiredTools.length ? (covered.length / task.requiredTools.length) * 5 : 0;
    const score = typeScore + toolScore;
    if (!best || score > best.score) {
      const parts = [
        typeIdx >= 0 ? `handles "${task.type}" tasks` : null,
        covered.length ? `has ${covered.join(", ")}` : null,
      ].filter(Boolean);
      best = { agent, score, reason: parts.join("; ") || "closest general fit" };
    }
  }
  if (!best || best.score === 0) {
    return { agent: AGENTS.strategy, reason: `no specialist matches type "${task.type}"; defaulting to Strategy` };
  }
  return { agent: best.agent, reason: best.reason };
}

export function agentById(id: string | null | undefined): AgentDefinition | undefined {
  return id ? AGENTS[id as AgentId] : undefined;
}
