import type { RiskLevel, VerificationReport } from "@/db/schema";

export type CheckInput = {
  output: string;
  truncated: boolean;
  deliverable: boolean;
  /** Tools the plan said this task must use, with whether each changes the outside world. */
  requiredTools: { name: string; externalEffect: boolean; riskLevel: RiskLevel }[];
  toolCalls: { toolName: string; status: string }[];
};

type Check = VerificationReport["checks"][number];

const PLACEHOLDER = /\[(insert|todo|tbd|placeholder|your [a-z ]+ here)[^\]]*\]|lorem ipsum|<placeholder>/i;

/**
 * Checks that need no model: they are cheap, deterministic, and cannot be talked around.
 * Verification only proceeds to the Verification Agent when all of these pass.
 */
export function deterministicChecks(input: CheckInput): Check[] {
  const text = input.output.trim();
  const checks: Check[] = [];

  checks.push({
    name: "output_exists",
    passed: text.length > 0,
    detail: text.length > 0 ? `${text.length} characters` : "The agent returned no output.",
  });

  const minLength = input.deliverable ? 200 : 40;
  checks.push({
    name: "output_substantive",
    passed: text.length >= minLength,
    detail: text.length >= minLength ? "Meets minimum length" : `Output is only ${text.length} characters (minimum ${minLength}).`,
  });

  checks.push({
    name: "output_complete",
    passed: !input.truncated,
    detail: input.truncated ? "Output was cut off at the model's token limit." : "Not truncated",
  });

  const placeholder = text.match(PLACEHOLDER);
  checks.push({
    name: "no_placeholders",
    passed: !placeholder,
    detail: placeholder ? `Contains placeholder text: "${placeholder[0]}"` : "No placeholder text",
  });

  // An external action only counts if the tool log shows it actually succeeded.
  for (const tool of input.requiredTools.filter((t) => t.externalEffect && t.riskLevel !== "LOW")) {
    const calls = input.toolCalls.filter((c) => c.toolName === tool.name);
    const succeeded = calls.some((c) => c.status === "SUCCEEDED");
    const rejected = calls.some((c) => c.status === "REJECTED");
    checks.push({
      name: `external_action:${tool.name}`,
      passed: succeeded || rejected,
      detail: succeeded
        ? `${tool.name} executed successfully`
        : rejected
          ? `${tool.name} was rejected by a human reviewer (not performed)`
          : `Task requires ${tool.name} but no successful call was recorded.`,
    });
  }

  return checks;
}

export function failedChecks(checks: Check[]): string[] {
  return checks.filter((c) => !c.passed).map((c) => c.detail);
}
