import type { RiskLevel } from "@/db/schema";

const ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function maxRisk(...levels: (RiskLevel | undefined | null)[]): RiskLevel {
  let best: RiskLevel = "LOW";
  for (const l of levels) if (l && ORDER[l] > ORDER[best]) best = l;
  return best;
}

/**
 * Policy:
 *  LOW    - executes automatically (analysis, drafts, reports, internal assets)
 *  MEDIUM - pauses for approval (communications, publishing, modifying external systems)
 *  HIGH   - pauses for explicit approval (financial, destructive, bulk/sensitive communication)
 */
export function requiresApproval(level: RiskLevel): boolean {
  return level !== "LOW";
}

type ToolRiskInfo<I> = { riskLevel: RiskLevel; risk?: (input: I) => RiskLevel };

/** Risk of one concrete tool invocation. Input-dependent risk can raise, never lower, the baseline. */
export function classifyToolCall<I>(tool: ToolRiskInfo<I>, input: I): RiskLevel {
  return maxRisk(tool.riskLevel, tool.risk?.(input));
}

const HIGH_PATTERNS =
  /\b(delete|deletion|destroy|wipe|erase|drop (the )?(table|database)|purchase|buy|pay(ment)?s?|charge|refund|wire|transfer (funds|money)|invoice customers|cancel (the )?subscription|terminate)\b/i;
const MEDIUM_PATTERNS =
  /\b(send|email|e-mail|publish|post|deploy|go live|launch|announce|notify|message|submit|upload|update (the )?(crm|website|listing)|schedule)\b/i;

export type TaskRiskInput = {
  type: string;
  title: string;
  description: string;
  declaredRisk?: RiskLevel | null;
  /** Baseline risk of each tool the task is expected to use. */
  toolRisks: RiskLevel[];
};

/**
 * Risk of a planned task. Wording is only inspected for "action" tasks - the ones that
 * act on the outside world - so that writing *about* payments or launches stays LOW.
 */
export function classifyTask(t: TaskRiskInput): RiskLevel {
  let fromText: RiskLevel = "LOW";
  if (t.type === "action") {
    const text = `${t.title}\n${t.description}`;
    fromText = HIGH_PATTERNS.test(text) ? "HIGH" : MEDIUM_PATTERNS.test(text) ? "MEDIUM" : "LOW";
  }
  return maxRisk(t.declaredRisk, fromText, ...t.toolRisks);
}

/**
 * HIGH-risk tasks are gated before any work starts. MEDIUM risk is gated at the individual
 * tool call instead, where the reviewer can see the exact payload being sent.
 */
export function taskNeedsUpfrontApproval(level: RiskLevel): boolean {
  return level === "HIGH";
}
