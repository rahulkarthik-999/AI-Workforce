import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setProviderOverride } from "@/ai";
import { getDb, resetDb, schema } from "@/db";
import { answerQuestions, cancelGoal, decideApproval, decideRecommendation, getGoal, goalSnapshot, resumeGoal, type Actor } from "@/engine/service";
import { rateLimit } from "@/lib/http";
import { createMemory, listMemories, memoryContext, updateMemory } from "@/memory/service";
import { toolRegistry } from "@/tools/registry";
import { defineTool } from "@/tools/types";
import {
  drive,
  freshWorld,
  interpretation,
  lastToolResults,
  LONG_OUTPUT,
  newActor,
  plan,
  ScriptedProvider,
  startGoal,
  state,
  synthesis,
  taskPrompt,
  verdict,
} from "./helpers";

let provider: ScriptedProvider;
let actor: Actor;

/** A real (in-process) external-effect tool so approval gating can be observed precisely. */
const sent: unknown[] = [];
const outboundTool = (name: string, risk: "MEDIUM" | "HIGH" = "MEDIUM") =>
  defineTool({
    name,
    description: "Send a campaign to customers",
    category: "email",
    inputSchema: z.object({ audience: z.number(), message: z.string() }),
    riskLevel: risk,
    externalEffect: true,
    available: () => ({ ok: true }),
    summarize: (i) => `Send campaign to ${i.audience} customers`,
    async execute(input) {
      sent.push(input);
      return { delivered: input.audience };
    },
  });

const THREE_STEP = plan([
  { key: "research", type: "research", title: "Research the market" },
  { key: "strategy", type: "strategy", title: "Define launch strategy", dependsOn: ["research"] },
  { key: "launch-plan", type: "writing", title: "Write the launch plan", dependsOn: ["strategy"] },
]);

beforeEach(async () => {
  ({ provider, actor } = await freshWorld());
  provider.structured.task_plan = () => THREE_STEP;
  sent.length = 0;
  toolRegistry.register(outboundTool("send_campaign") as never);
});

afterAll(async () => {
  setProviderOverride(undefined);
  await resetDb();
});

describe("end to end: goal -> interpretation -> task graph -> agents -> verification -> result -> next best action", () => {
  it("completes 'Create a launch plan for my SaaS.'", async () => {
    const goal = await startGoal(actor);
    const s = await drive(goal.id);

    // Goal interpretation
    expect(s.goal.status).toBe("COMPLETED");
    expect(s.goal.objective).toBe("Create a launch plan for a SaaS product");

    // Task graph with manager-assigned specialists
    expect(s.tasks).toHaveLength(3);
    expect(s.byKey.research!.assignedAgent).toBe("research");
    expect(s.byKey.strategy!.assignedAgent).toBe("strategy");
    expect(s.byKey["launch-plan"]!.assignedAgent).toBe("writing");

    // Every task executed, verified, and persisted its output
    for (const t of s.tasks) {
      expect(t.status).toBe("COMPLETED");
      expect(t.verificationStatus).toBe("PASSED");
      expect(t.verification?.verifiedBy).toBe("deterministic+agent");
      expect(t.output?.text).toContain("Deliverable");
      expect(t.costUsd).toBeGreaterThan(0);
    }

    // Dependencies were respected: strategy saw research output
    const strategyCall = provider.calls.find((c) => c.kind === "generate" && taskPrompt(c.req).includes("Define launch strategy"))!;
    expect(taskPrompt(strategyCall.req)).toContain("## Research the market");
    const order = s.events.filter((e) => e.type === "task.completed").map((e) => e.message);
    expect(order.map((m) => m.match(/"(.+)"/)![1])).toEqual(["Research the market", "Define launch strategy", "Write the launch plan"]);

    // Result, next best action, learning, memory, deliverables, cost tracking
    const snap = await goalSnapshot(actor, goal.id);
    expect(snap.result?.statusLabel).toBe("READY FOR LAUNCH");
    expect(snap.result?.stats).toMatchObject({ tasksTotal: 3, tasksCompleted: 3, tasksFailed: 0 });
    expect(snap.result?.synthesized).toBe(true);
    expect(snap.documents).toHaveLength(3);
    expect(snap.recommendations[0]).toMatchObject({ status: "PENDING", title: "Draft the launch announcement email" });
    expect(snap.requirements).toHaveLength(1);
    expect(snap.usage.calls).toBe(provider.calls.length);
    expect(snap.goal.costUsd).toBeGreaterThan(0);
    expect(snap.goal).not.toHaveProperty("leaseOwner");

    const db = await getDb();
    const learnings = await db.select().from(schema.learnings).where(eq(schema.learnings.goalId, goal.id));
    expect(learnings[0]).toMatchObject({ confidence: 0.4, pattern: expect.stringContaining("Research-then-strategy") });
    const memories = await listMemories(actor.workspaceId, actor.userId, { category: "RESULT" });
    expect(memories).toHaveLength(1);

    for (const type of ["goal.created", "goal.interpreted", "goal.planned", "agent.assigned", "task.started", "verification.passed", "task.completed", "result.created", "recommendation.created", "goal.completed"]) {
      expect(s.types, type).toContain(type);
    }
    // Transient streaming chunks are cleaned up once the final output is stored.
    expect(s.types).not.toContain("task.output_delta");
  });

  it("feeds learnings and memory from past goals into later planning", async () => {
    await createMemory(actor.workspaceId, actor.userId, { category: "PREFERENCE", title: "Tone", content: "Always write in a playful tone." });
    await drive((await startGoal(actor)).id);
    await drive((await startGoal(actor, "Plan a webinar for the product.")).id);
    const planCalls = provider.calls.filter((c) => c.name === "task_plan");
    const second = JSON.stringify(planCalls[1]!.req.messages);
    expect(second).toContain("Always write in a playful tone.");
    expect(second).toContain("LEARNINGS FROM PAST RESULTS");
    expect(second).toContain("Keep research ahead of strategy");
  });

  it("approving the next best action plans and executes follow-up tasks on the same goal", async () => {
    const goal = await startGoal(actor);
    await drive(goal.id);
    provider.structured.task_plan = () => plan([{ key: "announcement", title: "Write announcement email", dependsOn: ["launch-plan"] }]);
    provider.structured.goal_result = () => synthesis({ nextBestAction: null, learnings: [] });

    const snap = await goalSnapshot(actor, goal.id);
    const res = await decideRecommendation(actor, snap.recommendations[0]!.id, "APPROVED");
    expect(res.resumed).toBe(true);
    const s = await drive(goal.id);

    expect(s.goal.status).toBe("COMPLETED");
    expect(s.tasks).toHaveLength(4);
    expect(s.byKey["f1-announcement"]!.status).toBe("COMPLETED");
    const call = provider.calls.find((c) => c.kind === "generate" && taskPrompt(c.req).includes("Write announcement email"))!;
    expect(taskPrompt(call.req)).toContain("## Write the launch plan");
    await expect(decideRecommendation(actor, snap.recommendations[0]!.id, "DISMISSED")).rejects.toThrow(/already decided/);
  });

  it("dismissing a recommendation leaves the goal finished", async () => {
    const goal = await startGoal(actor);
    await drive(goal.id);
    const snap = await goalSnapshot(actor, goal.id);
    const res = await decideRecommendation(actor, snap.recommendations[0]!.id, "DISMISSED");
    expect(res.resumed).toBe(false);
    expect((await state(goal.id)).goal.status).toBe("COMPLETED");
  });
});

describe("goal interpretation", () => {
  it("pauses for critical questions once, then proceeds with the answers", async () => {
    provider.structured.goal_interpretation = (_req, n) =>
      n === 1
        ? interpretation({ missingInformation: [{ question: "What does the product do?", why: "Needed to research the market", critical: true }] })
        : interpretation({ knownContext: ["Product is a CRM for dentists"] });
    const goal = await startGoal(actor, "Launch my product.");
    let s = await drive(goal.id);
    expect(s.goal.status).toBe("NEEDS_INPUT");
    expect(s.tasks).toHaveLength(0);
    expect((await goalSnapshot(actor, goal.id)).goal.questions).toHaveLength(1);

    await answerQuestions(actor, goal.id, [{ question: "What does the product do?", answer: "A CRM for dentists" }]);
    s = await drive(goal.id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(JSON.stringify(provider.calls.find((c) => c.name === "task_plan")!.req.messages)).toContain("A CRM for dentists");
    await expect(answerQuestions(actor, goal.id, [{ question: "q", answer: "a" }])).rejects.toThrow(/not waiting/);
  });

  it("repairs an invalid plan once and fails the goal clearly if the planner cannot produce a valid graph", async () => {
    const cyclic = plan([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }]);
    provider.structured.task_plan = (_req, n) => (n === 1 ? cyclic : THREE_STEP);
    let s = await drive((await startGoal(actor)).id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(JSON.stringify(provider.calls.filter((c) => c.name === "task_plan")[1]!.req.messages)).toContain("cycle");

    provider.structured.task_plan = () => cyclic;
    s = await drive((await startGoal(actor)).id);
    expect(s.goal.status).toBe("FAILED");
    expect(s.goal.error).toMatch(/valid task graph/);
    expect(s.tasks).toHaveLength(0);
  });
});

describe("parallelism", () => {
  it("runs independent tasks in the same batch and dependents afterwards", async () => {
    provider.structured.task_plan = () =>
      plan([{ key: "a" }, { key: "b" }, { key: "c", dependsOn: ["a", "b"] }]);
    const s = await drive((await startGoal(actor)).id);
    expect(s.goal.status).toBe("COMPLETED");
    const started = s.events.filter((e) => e.type === "task.started").map((e) => e.message.match(/"(.+)"/)![1]);
    const firstCompleted = s.events.findIndex((e) => e.type === "task.completed");
    const startedBeforeAnyCompletion = s.events.slice(0, firstCompleted).filter((e) => e.type === "task.started").length;
    expect(startedBeforeAnyCompletion).toBe(2);
    expect(started[2]).toBe("c");
  });
});

describe("agent -> tool", () => {
  it("executes LOW-risk tools automatically and feeds results back to the agent", async () => {
    provider.structured.task_plan = () => plan([{ key: "pricing", type: "finance", requiredTools: ["calculator"] }]);
    provider.agent = (req) => {
      const results = lastToolResults(req);
      return results.length ? { text: `${LONG_OUTPUT}\nAnnual price: ${results[0]!.content}` } : { toolCalls: [{ name: "calculator", input: { expression: "49 * 12" } }] };
    };
    const goal = await startGoal(actor);
    const s = await drive(goal.id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(s.approvals).toHaveLength(0);
    expect(s.byKey.pricing!.output?.text).toContain("588");
    const snap = await goalSnapshot(actor, goal.id);
    expect(snap.toolCalls).toMatchObject([{ toolName: "calculator", status: "SUCCEEDED", riskLevel: "LOW" }]);
    expect(s.types).toEqual(expect.arrayContaining(["tool.started", "tool.succeeded"]));
  });

  it("returns validation and execution errors to the agent instead of crashing the task", async () => {
    provider.structured.task_plan = () => plan([{ key: "calc", type: "finance" }]);
    const seen: string[] = [];
    provider.agent = (req, n) => {
      for (const r of lastToolResults(req)) seen.push(`${r.isError ? "ERR" : "OK"}:${r.content}`);
      if (n === 1) return { toolCalls: [{ name: "calculator", input: { wrong: true } }] };
      if (n === 2) return { toolCalls: [{ name: "calculator", input: { expression: "1/0" } }] };
      return { text: LONG_OUTPUT };
    };
    const s = await drive((await startGoal(actor)).id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(seen[0]).toMatch(/^ERR:Invalid input for calculator/);
    expect(seen[1]).toMatch(/^ERR:Division by zero/);
  });

  it("bounds an agent that keeps calling tools: tools are withheld on the last iteration so it must conclude", async () => {
    provider.structured.task_plan = () => plan([{ key: "loop", type: "finance" }]);
    // This agent would call the calculator forever if allowed to.
    provider.agent = () => ({ toolCalls: [{ name: "calculator", input: { expression: "1+1" } }] });
    const goal = await startGoal(actor);
    const s = await drive(goal.id);
    const agentCalls = provider.calls.filter((c) => c.kind === "generate");
    // MAX_AGENT_ITERATIONS is 4 in tests: three tool rounds, then a final call without tools.
    expect(agentCalls).toHaveLength(4);
    expect((agentCalls[3]!.req as { tools?: unknown[] }).tools).toBeUndefined();
    expect((await goalSnapshot(actor, goal.id)).toolCalls).toHaveLength(3);
    expect(s.byKey.loop!.status).toBe("COMPLETED");
  });
});

describe("approval -> resume", () => {
  const campaignPlan = () => plan([{ key: "campaign", type: "action", title: "Send launch campaign", requiredTools: ["send_campaign"], riskLevel: "MEDIUM" }, { key: "report", dependsOn: ["campaign"] }]);
  const campaignAgent = (req: Parameters<ScriptedProvider["agent"]>[0]) => {
    if (!taskPrompt(req).includes("Send launch campaign")) return { text: LONG_OUTPUT };
    const results = lastToolResults(req);
    if (!results.length) return { toolCalls: [{ name: "send_campaign", input: { audience: 2430, message: "New product launch..." } }] };
    return { text: `${LONG_OUTPUT}\nTool said: ${results[0]!.content}` };
  };

  it("pauses a MEDIUM-risk tool call, persists the request, and executes exactly once after approval", async () => {
    provider.structured.task_plan = campaignPlan;
    provider.agent = campaignAgent;
    const goal = await startGoal(actor);
    let s = await drive(goal.id);

    expect(s.goal.status).toBe("WAITING_APPROVAL");
    expect(s.byKey.campaign!.status).toBe("WAITING_APPROVAL");
    expect(s.byKey.report!.status).toBe("PENDING");
    expect(sent).toHaveLength(0); // nothing left the building
    expect(s.approvals).toMatchObject([
      { kind: "TOOL_CALL", status: "PENDING", riskLevel: "MEDIUM", title: "Send campaign to 2430 customers", payload: { audience: 2430, message: "New product launch..." } },
    ]);

    // Driving again without a decision changes nothing.
    s = await drive(goal.id);
    expect(s.goal.status).toBe("WAITING_APPROVAL");
    expect(sent).toHaveLength(0);

    await decideApproval(actor, s.approvals[0]!.id, "APPROVED", "Looks good");
    s = await drive(goal.id);
    expect(sent).toEqual([{ audience: 2430, message: "New product launch..." }]);
    expect(s.goal.status).toBe("COMPLETED");
    expect(s.byKey.campaign!.output?.text).toContain('"delivered":2430');
    expect(s.approvals[0]).toMatchObject({ status: "APPROVED", decidedById: actor.userId, decisionNote: "Looks good" });
    expect(s.types).toEqual(expect.arrayContaining(["approval.requested", "goal.waiting_approval", "approval.approved"]));
    await expect(decideApproval(actor, s.approvals[0]!.id, "REJECTED")).rejects.toThrow(/already decided/);

    const db = await getDb();
    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "approval.approved"));
    expect(audit).toHaveLength(1);
  });

  it("never executes a rejected tool call and tells the agent it was refused", async () => {
    provider.structured.task_plan = campaignPlan;
    provider.agent = campaignAgent;
    const goal = await startGoal(actor);
    let s = await drive(goal.id);
    await decideApproval(actor, s.approvals[0]!.id, "REJECTED", "Wrong audience");
    s = await drive(goal.id);

    expect(sent).toHaveLength(0);
    expect(s.byKey.campaign!.output?.text).toMatch(/REJECTED this action: Wrong audience/);
    const snap = await goalSnapshot(actor, goal.id);
    expect(snap.toolCalls[0]).toMatchObject({ toolName: "send_campaign", status: "REJECTED" });
    expect(s.goal.status).toBe("COMPLETED");
  });

  it("gates a HIGH-risk task before any work starts; rejection cancels it and blocks only its dependents", async () => {
    provider.structured.task_plan = () =>
      plan([
        { key: "cleanup", type: "action", title: "Delete inactive customer records", riskLevel: "HIGH" },
        { key: "after", dependsOn: ["cleanup"] },
        { key: "independent" },
      ]);
    const goal = await startGoal(actor);
    let s = await drive(goal.id);
    expect(s.byKey.cleanup!.riskLevel).toBe("HIGH");
    expect(s.byKey.cleanup!.status).toBe("WAITING_APPROVAL");
    expect(s.byKey.independent!.status).toBe("COMPLETED");
    expect(s.approvals).toMatchObject([{ kind: "TASK", riskLevel: "HIGH", status: "PENDING" }]);
    expect(provider.calls.some((c) => c.kind === "generate" && taskPrompt(c.req).includes("Delete inactive"))).toBe(false);

    await decideApproval(actor, s.approvals[0]!.id, "REJECTED");
    s = await drive(goal.id);
    expect(s.byKey.cleanup!.status).toBe("CANCELLED");
    expect(s.byKey.after!.status).toBe("BLOCKED");
    expect(s.goal.status).toBe("PARTIAL");
    expect(provider.calls.some((c) => c.kind === "generate" && taskPrompt(c.req).includes("Delete inactive"))).toBe(false);
  });

  it("an approved HIGH-risk task still needs explicit approval for each HIGH-risk tool call", async () => {
    toolRegistry.register(outboundTool("wire_funds", "HIGH") as never);
    provider.structured.task_plan = () => plan([{ key: "pay", type: "action", title: "Pay the vendor invoice", requiredTools: ["wire_funds"], riskLevel: "HIGH" }]);
    provider.agent = (req) => (lastToolResults(req).length ? { text: LONG_OUTPUT } : { toolCalls: [{ name: "wire_funds", input: { audience: 1, message: "pay" } }] });
    const goal = await startGoal(actor);
    let s = await drive(goal.id);
    await decideApproval(actor, s.approvals[0]!.id, "APPROVED");
    s = await drive(goal.id);
    expect(sent).toHaveLength(0);
    expect(s.goal.status).toBe("WAITING_APPROVAL");
    const pending = s.approvals.filter((a) => a.status === "PENDING");
    expect(pending).toMatchObject([{ kind: "TOOL_CALL", riskLevel: "HIGH" }]);
    await decideApproval(actor, pending[0]!.id, "APPROVED");
    s = await drive(goal.id);
    expect(sent).toHaveLength(1);
    expect(s.goal.status).toBe("COMPLETED");
    toolRegistry.unregister("wire_funds");
  });
});

describe("verification -> retry / repair / replan", () => {
  it("retries with the verifier's feedback and the rejected draft, then passes", async () => {
    provider.structured.task_plan = () => plan([{ key: "copy" }]);
    provider.structured.verification_verdict = (_r, n) => verdict(n > 1);
    const s = await drive((await startGoal(actor)).id);
    expect(s.byKey.copy).toMatchObject({ status: "COMPLETED", retryCount: 1, verificationStatus: "PASSED" });
    const attempts = provider.calls.filter((c) => c.kind === "generate");
    expect(attempts).toHaveLength(2);
    expect(taskPrompt(attempts[1]!.req)).toContain("Missing pricing section");
    expect(taskPrompt(attempts[1]!.req)).toContain("Your rejected output");
    expect(s.types).toEqual(expect.arrayContaining(["verification.failed", "task.retry", "verification.passed"]));
  });

  it("gives the verifier upstream outputs and the goal-wide action log as evidence", async () => {
    provider.structured.task_plan = () =>
      plan([
        { key: "campaign", type: "action", title: "Send launch campaign", requiredTools: ["send_campaign"], riskLevel: "MEDIUM" },
        { key: "report", title: "Report on the campaign", dependsOn: ["campaign"] },
      ]);
    provider.agent = (req) => {
      if (!taskPrompt(req).includes("**Send launch campaign**")) return { text: LONG_OUTPUT };
      return lastToolResults(req).length ? { text: `${LONG_OUTPUT}
CAMPAIGN-RESULT-MARKER` } : { toolCalls: [{ name: "send_campaign", input: { audience: 10, message: "hi" } }] };
    };
    const goal = await startGoal(actor);
    let s = await drive(goal.id);
    await decideApproval(actor, s.approvals[0]!.id, "APPROVED");
    s = await drive(goal.id);
    expect(s.goal.status).toBe("COMPLETED");
    const reportVerification = provider.calls.filter((c) => c.name === "verification_verdict").map((c) => JSON.stringify(c.req.messages)).find((m) => m.includes("# Task\\nReport on the campaign"))!;
    // A report about upstream work must be judged against what upstream actually did.
    expect(reportVerification).toContain("CAMPAIGN-RESULT-MARKER");
    expect(reportVerification).toContain("[SUCCEEDED] send_campaign");
  });

  it("fails deterministic checks without spending a verification call", async () => {
    provider.structured.task_plan = () => plan([{ key: "copy" }]);
    provider.agent = (_r, n) => ({ text: n === 1 ? "tiny" : LONG_OUTPUT });
    const s = await drive((await startGoal(actor)).id);
    expect(s.byKey.copy!.status).toBe("COMPLETED");
    expect(provider.count("verification_verdict")).toBe(1);
  });

  it("does not accept a claimed external action that the tool log does not confirm", async () => {
    provider.structured.task_plan = () => plan([{ key: "campaign", type: "action", title: "Send launch campaign", requiredTools: ["send_campaign"], riskLevel: "MEDIUM" }]);
    provider.agent = () => ({ text: `${LONG_OUTPUT}\nThe campaign has been sent to all customers.` });
    const s = await drive((await startGoal(actor)).id);
    expect(s.byKey.campaign!.status).toBe("FAILED");
    expect(s.byKey.campaign!.verification?.issues[0]).toMatch(/no successful call/);
    expect(provider.count("verification_verdict")).toBe(0);
    expect(s.goal.status).toBe("FAILED");
  });

  it("after retries are exhausted the task fails, dependents are blocked, and the rest of the goal survives", async () => {
    provider.structured.task_plan = () => plan([{ key: "bad", title: "Bad task" }, { key: "child", dependsOn: ["bad"] }, { key: "good", title: "Good task" }]);
    provider.structured.verification_verdict = (req) => verdict(!JSON.stringify(req.messages).includes("Bad task"));
    const goal = await startGoal(actor);
    const s = await drive(goal.id);
    expect(s.byKey.bad).toMatchObject({ status: "FAILED", retryCount: 1 });
    expect(s.byKey.child!.status).toBe("BLOCKED");
    expect(s.byKey.good!.status).toBe("COMPLETED");
    expect(s.goal.status).toBe("PARTIAL");
    expect(provider.count("recovery_decision")).toBe(1);
    const snap = await goalSnapshot(actor, goal.id);
    expect(snap.result?.stats).toMatchObject({ tasksCompleted: 1, tasksFailed: 1, tasksBlocked: 1 });
  });

  it("the manager can replace a failed task; dependents are rewired to the replacement", async () => {
    provider.structured.task_plan = (_r, n) =>
      n === 1
        ? plan([{ key: "bad", title: "Bad task" }, { key: "child", title: "Child task", dependsOn: ["bad"] }])
        : plan([{ key: "alt", title: "Alternative approach" }]);
    provider.structured.verification_verdict = (req) => verdict(!JSON.stringify(req.messages).includes("# Task\\nBad task"));
    provider.structured.recovery_decision = () => ({ decision: "replace", reasoning: "A narrower scope can work", approach: "Narrow the scope" });
    const s = await drive((await startGoal(actor)).id);
    expect(s.byKey.bad!.status).toBe("FAILED");
    expect(s.byKey["r1-alt"]).toMatchObject({ status: "COMPLETED", parentTaskId: s.byKey.bad!.id });
    expect(s.byKey.child!.status).toBe("COMPLETED");
    expect(s.goal.replanCount).toBe(1);
    expect(s.types).toContain("goal.replanned");
    const childCall = provider.calls.find((c) => c.kind === "generate" && taskPrompt(c.req).includes("**Child task**"))!;
    expect(taskPrompt(childCall.req)).toContain("## Alternative approach");
  });

  it("retries a task whose agent call throws a transient error", async () => {
    provider.structured.task_plan = () => plan([{ key: "flaky" }]);
    let n = 0;
    provider.agent = () => {
      if (++n === 1) throw new Error("upstream connection reset");
      return { text: LONG_OUTPUT };
    };
    const s = await drive((await startGoal(actor)).id);
    expect(s.byKey.flaky).toMatchObject({ status: "COMPLETED", retryCount: 1 });
  });
});

describe("cost control", () => {
  it("halts at the goal budget with an actionable error, and resumes after the budget is raised", async () => {
    // Each scripted call costs $0.0175 at the unpriced fallback rate.
    const goal = await startGoal(actor, "Create a launch plan for my SaaS.", 0.05);
    let s = await drive(goal.id);
    expect(s.goal.status).toBe("FAILED");
    expect(s.goal.error).toMatch(/budget of \$0\.05 reached/);
    expect(s.types).toContain("budget.exceeded");
    expect(s.tasks.every((t) => t.status !== "RUNNING")).toBe(true);
    const callsAtHalt = provider.calls.length;
    expect(callsAtHalt).toBeLessThanOrEqual(4);

    await resumeGoal(actor, goal.id, { addBudgetUsd: 1 });
    s = await drive(goal.id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(s.goal.budgetUsd).toBeCloseTo(1.05);
    expect(s.tasks.every((t) => t.status === "COMPLETED")).toBe(true);
  });

  it("records every model call with tokens, cost and purpose", async () => {
    const goal = await startGoal(actor);
    await drive(goal.id);
    const db = await getDb();
    const rows = await db.select().from(schema.usageRecords).where(eq(schema.usageRecords.goalId, goal.id));
    expect(rows).toHaveLength(provider.calls.length);
    expect(new Set(rows.map((r) => r.purpose))).toEqual(new Set(["interpret", "plan", "agent:research", "agent:strategy", "agent:writing", "verification", "result"]));
    const total = rows.reduce((a, r) => a + r.costUsd, 0);
    expect((await state(goal.id)).goal.costUsd).toBeCloseTo(total, 5);
    expect(rows.every((r) => r.priced === false && r.inputTokens === 1000)).toBe(true);
  });

  it("refuses to create a goal when no AI provider is configured", async () => {
    setProviderOverride(null);
    await expect(startGoal(actor)).rejects.toThrow(/No AI provider is configured/);
  });
});

describe("resumability and cancellation", () => {
  it("recovers tasks orphaned by a dead runner and continues from persisted state", async () => {
    const goal = await startGoal(actor);
    await drive(goal.id);
    const db = await getDb();
    // Simulate a crash mid-task: goal active, one task stuck RUNNING, lease expired.
    await db.update(schema.goals).set({ status: "RUNNING", completedAt: null, leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.goals.id, goal.id));
    await db.update(schema.tasks).set({ status: "RUNNING", output: null }).where(and(eq(schema.tasks.goalId, goal.id), eq(schema.tasks.key, "launch-plan")));
    const before = provider.calls.filter((c) => c.kind === "generate").length;

    const s = await drive(goal.id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(s.byKey["launch-plan"]!.status).toBe("COMPLETED");
    expect(s.types).toContain("goal.resumed");
    // Only the orphaned task was re-executed; completed work was kept.
    expect(provider.calls.filter((c) => c.kind === "generate").length - before).toBe(1);
  });

  it("a live lease prevents a second runner from executing the same goal", async () => {
    const goal = await startGoal(actor);
    const db = await getDb();
    await db.update(schema.goals).set({ leaseOwner: "other", leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.goals.id, goal.id));
    const s = await drive(goal.id);
    expect(s.goal.status).toBe("INTERPRETING");
    expect(provider.calls).toHaveLength(0);
  });

  it("cancels a goal, its open tasks and pending approvals", async () => {
    provider.structured.task_plan = () => plan([{ key: "campaign", type: "action", title: "Delete everything", riskLevel: "HIGH" }, { key: "next", dependsOn: ["campaign"] }]);
    const goal = await startGoal(actor);
    await drive(goal.id);
    await cancelGoal(actor, goal.id);
    const s = await drive(goal.id);
    expect(s.goal.status).toBe("CANCELLED");
    expect(s.tasks.every((t) => t.status === "CANCELLED")).toBe(true);
    expect(s.approvals[0]!.status).toBe("EXPIRED");
    await expect(cancelGoal(actor, goal.id)).rejects.toThrow(/already finished/);
  });

  it("retries a failed goal: failed and blocked tasks are re-queued, completed ones kept", async () => {
    provider.structured.task_plan = () => plan([{ key: "bad", title: "Bad task" }, { key: "child", dependsOn: ["bad"] }, { key: "good" }]);
    let failing = true;
    provider.structured.verification_verdict = (req) => verdict(!(failing && JSON.stringify(req.messages).includes("Bad task")));
    const goal = await startGoal(actor);
    await drive(goal.id);
    failing = false;
    const before = provider.calls.filter((c) => c.kind === "generate").length;
    await resumeGoal(actor, goal.id);
    const s = await drive(goal.id);
    expect(s.goal.status).toBe("COMPLETED");
    expect(provider.calls.filter((c) => c.kind === "generate").length - before).toBe(2);
  });
});

describe("workspace isolation and memory permissions", () => {
  it("hides goals, approvals and recommendations from other workspaces", async () => {
    provider.structured.task_plan = () => plan([{ key: "campaign", type: "action", title: "Delete everything", riskLevel: "HIGH" }]);
    const goal = await startGoal(actor);
    const s = await drive(goal.id);
    const stranger = await newActor();
    await expect(getGoal(stranger, goal.id)).rejects.toThrow(/not found/);
    await expect(goalSnapshot(stranger, goal.id)).rejects.toThrow(/not found/);
    await expect(decideApproval(stranger, s.approvals[0]!.id, "APPROVED")).rejects.toThrow(/not found/);
    await expect(cancelGoal(stranger, goal.id)).rejects.toThrow(/not found/);
    await expect(getGoal(actor, "not-a-uuid")).rejects.toThrow(/not found/);
    expect((await state(goal.id)).approvals[0]!.status).toBe("PENDING");
  });

  it("keeps USER/PREFERENCE memories private to their owner and other workspaces fully separate", async () => {
    const db = await getDb();
    const teammate = await newActor();
    // Put the teammate in the same workspace as the actor.
    await db.insert(schema.workspaceMembers).values({ workspaceId: actor.workspaceId, userId: teammate.userId });
    const sameWs = { userId: teammate.userId, workspaceId: actor.workspaceId };
    const outsider = await newActor();

    const pref = await createMemory(actor.workspaceId, actor.userId, { category: "PREFERENCE", title: "Tone", content: "Formal" });
    const project = await createMemory(actor.workspaceId, actor.userId, { category: "PROJECT", title: "Product", content: "CRM for dentists" });
    expect(pref.userId).toBe(actor.userId);
    expect(project.userId).toBeNull();

    expect((await listMemories(sameWs.workspaceId, sameWs.userId)).map((m) => m.title)).toEqual(["Product"]);
    expect(await listMemories(outsider.workspaceId, outsider.userId)).toEqual([]);
    expect(await memoryContext(sameWs.workspaceId, sameWs.userId)).not.toContain("Formal");
    expect(await memoryContext(actor.workspaceId, actor.userId)).toContain("Formal");

    await expect(updateMemory(sameWs.workspaceId, sameWs.userId, pref.id, { content: "hacked" })).rejects.toThrow(/not found/);
    await expect(updateMemory(outsider.workspaceId, outsider.userId, project.id, { content: "hacked" })).rejects.toThrow(/not found/);
    const edited = await updateMemory(sameWs.workspaceId, sameWs.userId, project.id, { content: "CRM for orthodontists" });
    expect(edited.content).toBe("CRM for orthodontists");
  });
});

describe("rate limiting", () => {
  it("allows up to the limit within a window and rejects beyond it", async () => {
    await rateLimit("test:key", 2, 3600);
    await rateLimit("test:key", 2, 3600);
    await expect(rateLimit("test:key", 2, 3600)).rejects.toThrow(/Too many requests/);
    await rateLimit("test:other", 2, 3600);
  });
});
