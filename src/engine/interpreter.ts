import "server-only";
import { z } from "zod";
import type { MeteredAI } from "@/ai";
import type { Clarification, GoalInterpretation } from "@/db/schema";

export const interpretationSchema = z.object({
  objective: z.string().describe("One sentence: the outcome the user wants"),
  constraints: z.array(z.string()),
  target: z.string().nullable().describe("Target audience / market / metric, if stated or clearly implied"),
  deadline: z.string().nullable().describe("Deadline exactly as the user stated it, or null"),
  knownContext: z.array(z.string()).describe("Relevant facts already known from the request or memory"),
  missingInformation: z.array(
    z.object({
      question: z.string(),
      why: z.string(),
      critical: z.boolean().describe("True ONLY if useful work is impossible without the answer"),
    }),
  ),
});

const SYSTEM = `You are the Goal Interpreter of an AI workforce platform. Convert the user's natural-language goal into structured data.

Rules:
- Do not interrogate the user. The workforce can make and state reasonable assumptions.
- Mark missing information as critical ONLY when work cannot meaningfully start without it (for example: "launch my product" with no indication anywhere of what the product is).
- Preferences, nice-to-haves, and anything a competent professional would assume are NOT critical.
- Use workspace memory as known context; never ask for something memory already answers.
- At most 3 critical questions, each specific and answerable in one line.
- Do not invent facts about the user's business.`;

export const MAX_QUESTIONS = 3;

/** Questions that must be answered before planning. Empty once the user has answered a round. */
export function blockingQuestions(interp: GoalInterpretation, clarifications: Clarification[]) {
  // We only ever ask one round. After that the workforce proceeds on stated assumptions.
  if (clarifications.length > 0) return [];
  return interp.missingInformation.filter((m) => m.critical).slice(0, MAX_QUESTIONS);
}

export async function interpretGoal(
  ai: MeteredAI,
  input: { prompt: string; clarifications: Clarification[]; memory: string; signal?: AbortSignal },
): Promise<GoalInterpretation> {
  const answered = input.clarifications.length
    ? `\n\n# Clarifications already provided by the user\n${input.clarifications.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n")}\n\nThe user has answered. Do not mark anything as critical now.`
    : "";
  const { object } = await ai.structured({
    tier: "fast",
    system: SYSTEM,
    schema: interpretationSchema,
    schemaName: "goal_interpretation",
    maxTokens: 2000,
    signal: input.signal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `# User goal\n${input.prompt}${answered}\n\n# Workspace memory\n${input.memory || "(empty)"}`,
          },
        ],
      },
    ],
  });
  return object;
}
