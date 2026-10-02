import { describe, expect, it } from "vitest";
import { assignAgent } from "@/agents/assign";
import { estimateCost, parsePricingOverrides, priceFor } from "@/ai/pricing";
import { deterministicChecks, failedChecks } from "@/engine/checks";
import { pickBatch, progressPercent, resolveTransitions, topologicalOrder, validateGraph } from "@/engine/graph";
import { blockingQuestions } from "@/engine/interpreter";
import { normalizePlan } from "@/engine/plan";
import { computeStats, outcomeStatus } from "@/engine/result";
import { classifyTask, classifyToolCall, maxRisk, requiresApproval, taskNeedsUpfrontApproval } from "@/engine/risk";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { evaluate } from "@/tools/calculator";
import { isPlaceholderHost } from "@/tools/registry";
import { assertPublicUrl, isBlockedIp } from "@/tools/ssrf";
import { interpretation, plan, task } from "./helpers";

describe("goal parsing", () => {
  const interp = interpretation({
    missingInformation: [
      { question: "What is the product?", why: "unknown", critical: true },
      { question: "Preferred tone?", why: "nice to have", critical: false },
      { question: "Q3", why: "", critical: true },
      { question: "Q4", why: "", critical: true },
      { question: "Q5", why: "", critical: true },
    ],
  });

  it("asks only critical questions, capped at three", () => {
    const qs = blockingQuestions(interp, []);
    expect(qs.map((q) => q.question)).toEqual(["What is the product?", "Q3", "Q4"]);
  });

  it("never asks a second round", () => {
    expect(blockingQuestions(interp, [{ question: "What is the product?", answer: "A CRM" }])).toEqual([]);
  });

  it("proceeds without questions when nothing is critical", () => {
    expect(blockingQuestions(interpretation(), [])).toEqual([]);
  });
});

describe("task graph", () => {
  it("accepts a valid DAG and orders it", () => {
    const nodes = [
      { key: "c", dependsOn: ["a", "b"] },
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
    ];
    expect(validateGraph(nodes, 10)).toEqual([]);
    expect(topologicalOrder(nodes)).toEqual(["a", "b", "c"]);
  });

  it("rejects cycles, unknown dependencies, duplicates and oversize plans", () => {
    expect(validateGraph([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }], 10)[0]!.message).toMatch(/cycle/);
    expect(validateGraph([{ key: "a", dependsOn: ["zzz"] }], 10)[0]!.message).toMatch(/unknown task/);
    expect(validateGraph([{ key: "a", dependsOn: ["a"] }], 10)[0]!.message).toMatch(/itself/);
    expect(validateGraph([{ key: "a", dependsOn: [] }, { key: "a", dependsOn: [] }], 10)[0]!.message).toMatch(/Duplicate/);
    expect(validateGraph([{ key: "a", dependsOn: [] }, { key: "b", dependsOn: [] }], 1)[0]!.message).toMatch(/limit/);
    expect(validateGraph([], 5)[0]!.message).toMatch(/no tasks/);
  });

  it("promotes tasks whose dependencies completed and keeps others pending", () => {
    const r = resolveTransitions(
      [
        { id: "a", status: "COMPLETED", priority: 1 },
        { id: "b", status: "PENDING", priority: 1 },
        { id: "c", status: "PENDING", priority: 1 },
        { id: "d", status: "PENDING", priority: 1 },
      ],
      [
        { taskId: "b", dependsOnTaskId: "a" },
        { taskId: "c", dependsOnTaskId: "b" },
      ],
    );
    expect(r.ready.sort()).toEqual(["b", "d"]);
    expect(r.blocked).toEqual([]);
  });

  it("blocks dependents of failed tasks transitively, without touching independent branches", () => {
    const r = resolveTransitions(
      [
        { id: "a", status: "FAILED", priority: 1 },
        { id: "b", status: "PENDING", priority: 1 },
        { id: "c", status: "PENDING", priority: 1 },
        { id: "x", status: "PENDING", priority: 1 },
      ],
      [
        { taskId: "b", dependsOnTaskId: "a" },
        { taskId: "c", dependsOnTaskId: "b" },
      ],
    );
    expect(r.blocked.sort()).toEqual(["b", "c"]);
    expect(r.ready).toEqual(["x"]);
  });

  it("picks the highest-priority batch and computes progress", () => {
    const batch = pickBatch([{ priority: 3, id: 1 }, { priority: 1, id: 2 }, { priority: 2, id: 3 }], 2);
    expect(batch.map((b) => b.id)).toEqual([2, 3]);
    expect(progressPercent([{ status: "COMPLETED" }, { status: "RUNNING" }, { status: "PENDING" }, { status: "COMPLETED" }])).toBe(50);
    expect(progressPercent([])).toBe(0);
  });
});

describe("plan normalization (task creation)", () => {
  const opts = { maxTasks: 10, availableTools: ["calculator"] };

  it("slugs keys, rewrites dependencies, drops unknown tools and clamps priority", () => {
    const raw = plan([
      { key: "Market Research!", priority: 0 },
      { key: "Strategy", dependsOn: ["Market Research!"], requiredTools: ["calculator", "teleport"], priority: 99 },
    ]);
    const { plan: p, issues } = normalizePlan(raw, opts);
    expect(issues).toEqual([]);
    expect(p.tasks.map((t) => t.key)).toEqual(["market-research", "strategy"]);
    expect(p.tasks[1]!.dependsOn).toEqual(["market-research"]);
    expect(p.tasks[1]!.requiredTools).toEqual(["calculator"]);
    expect(p.tasks.map((t) => t.priority)).toEqual([3, 5]);
  });

  it("reports cycles and unknown dependencies instead of persisting them", () => {
    expect(normalizePlan(plan([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }]), opts).issues.length).toBeGreaterThan(0);
    expect(normalizePlan(plan([{ key: "a", dependsOn: ["ghost"] }]), opts).issues.length).toBeGreaterThan(0);
    expect(normalizePlan({ requirements: [], tasks: [] }, opts).issues.length).toBeGreaterThan(0);
  });

  it("prefixes follow-up tasks and lets them depend on existing completed tasks", () => {
    const { plan: p, issues } = normalizePlan(plan([{ key: "email", dependsOn: ["launch-plan"] }]), {
      ...opts,
      existingKeys: ["launch-plan"],
      keyPrefix: "f1-",
    });
    expect(issues).toEqual([]);
    expect(p.tasks[0]!.key).toBe("f1-email");
    expect(p.tasks[0]!.dependsOn).toEqual(["launch-plan"]);
  });

  it("de-duplicates colliding keys", () => {
    const { plan: p } = normalizePlan({ requirements: [], tasks: [task({ key: "a" }), task({ key: "A" })] }, opts);
    expect(new Set(p.tasks.map((t) => t.key)).size).toBe(p.tasks.length);
  });
});

describe("risk classification", () => {
  it("orders risk levels", () => {
    expect(maxRisk("LOW", "HIGH", "MEDIUM")).toBe("HIGH");
    expect(maxRisk(undefined, null)).toBe("LOW");
  });

  it("LOW runs automatically; MEDIUM and HIGH need approval", () => {
    expect(requiresApproval("LOW")).toBe(false);
    expect(requiresApproval("MEDIUM")).toBe(true);
    expect(requiresApproval("HIGH")).toBe(true);
  });

  it("input-dependent tool risk can raise but never lower the baseline", () => {
    const http = { riskLevel: "LOW" as const, risk: (i: { method: string }) => (i.method === "GET" ? ("LOW" as const) : i.method === "DELETE" ? ("HIGH" as const) : ("MEDIUM" as const)) };
    expect(classifyToolCall(http, { method: "GET" })).toBe("LOW");
    expect(classifyToolCall(http, { method: "POST" })).toBe("MEDIUM");
    expect(classifyToolCall(http, { method: "DELETE" })).toBe("HIGH");
    expect(classifyToolCall({ riskLevel: "MEDIUM" as const, risk: () => "LOW" as const }, {})).toBe("MEDIUM");
  });

  it("content about risky topics stays LOW; real actions are classified by wording and tools", () => {
    const base = { declaredRisk: "LOW" as const, toolRisks: [] };
    expect(classifyTask({ ...base, type: "writing", title: "Write pricing page with payment plans", description: "Describe how to purchase" })).toBe("LOW");
    expect(classifyTask({ ...base, type: "action", title: "Send launch email to customers", description: "" })).toBe("MEDIUM");
    expect(classifyTask({ ...base, type: "action", title: "Delete inactive customer records", description: "" })).toBe("HIGH");
    expect(classifyTask({ ...base, type: "action", title: "Purchase ad credits", description: "" })).toBe("HIGH");
    expect(classifyTask({ ...base, type: "marketing", title: "Outreach", description: "", toolRisks: ["MEDIUM"] })).toBe("MEDIUM");
    expect(classifyTask({ type: "action", title: "Sync", description: "", declaredRisk: "HIGH", toolRisks: [] })).toBe("HIGH");
  });

  it("gates only HIGH-risk tasks up front", () => {
    expect(taskNeedsUpfrontApproval("HIGH")).toBe(true);
    expect(taskNeedsUpfrontApproval("MEDIUM")).toBe(false);
  });
});

describe("verification checks", () => {
  const good = { output: "x".repeat(400), truncated: false, deliverable: true, requiredTools: [], toolCalls: [] };

  it("passes a complete output", () => {
    expect(failedChecks(deterministicChecks(good))).toEqual([]);
  });

  it("fails empty, thin, truncated and placeholder outputs", () => {
    expect(failedChecks(deterministicChecks({ ...good, output: "  " })).length).toBeGreaterThan(0);
    expect(failedChecks(deterministicChecks({ ...good, output: "too short" }))[0]).toMatch(/minimum/);
    expect(failedChecks(deterministicChecks({ ...good, truncated: true }))[0]).toMatch(/cut off/);
    expect(failedChecks(deterministicChecks({ ...good, output: `${good.output} [INSERT COMPANY NAME]` }))[0]).toMatch(/placeholder/i);
  });

  it("requires proof that a required external action actually succeeded", () => {
    const email = [{ name: "send_email", externalEffect: true, riskLevel: "MEDIUM" as const }];
    expect(failedChecks(deterministicChecks({ ...good, requiredTools: email }))[0]).toMatch(/no successful call/);
    expect(failedChecks(deterministicChecks({ ...good, requiredTools: email, toolCalls: [{ toolName: "send_email", status: "FAILED" }] })).length).toBe(1);
    expect(failedChecks(deterministicChecks({ ...good, requiredTools: email, toolCalls: [{ toolName: "send_email", status: "SUCCEEDED" }] }))).toEqual([]);
    // A human rejection is a legitimate outcome, not an agent failure.
    expect(failedChecks(deterministicChecks({ ...good, requiredTools: email, toolCalls: [{ toolName: "send_email", status: "REJECTED" }] }))).toEqual([]);
  });
});

describe("result stats", () => {
  it("derives outcome from measured task states", () => {
    const goal = { startedAt: new Date(0), createdAt: new Date(0), costUsd: 0.5 };
    const stats = computeStats(goal, [{ status: "COMPLETED", retryCount: 1 }, { status: "FAILED", retryCount: 2 }, { status: "BLOCKED", retryCount: 0 }], { inputTokens: 10, outputTokens: 5 }, new Date(60_000));
    expect(stats).toMatchObject({ tasksTotal: 3, tasksCompleted: 1, tasksFailed: 1, tasksBlocked: 1, retries: 3, executionMs: 60_000, costUsd: 0.5 });
    expect(outcomeStatus(stats)).toBe("PARTIAL");
    expect(outcomeStatus({ ...stats, tasksCompleted: 3 })).toBe("COMPLETED");
    expect(outcomeStatus({ ...stats, tasksCompleted: 0 })).toBe("FAILED");
  });
});

describe("manager assignment", () => {
  it("routes by task type", () => {
    expect(assignAgent({ type: "research", requiredTools: [] }).agent.id).toBe("research");
    expect(assignAgent({ type: "finance", requiredTools: ["calculator"] }).agent.id).toBe("finance");
    expect(assignAgent({ type: "creative", requiredTools: [] }).agent.id).toBe("creative");
  });

  it("routes actions by the tools they need and falls back sensibly", () => {
    expect(assignAgent({ type: "action", requiredTools: ["send_email"] }).agent.id).toBe("marketing");
    expect(assignAgent({ type: "unknown-type", requiredTools: [] }).agent.id).toBe("strategy");
    expect(assignAgent({ type: "unknown-type", requiredTools: ["generate_image"] }).agent.id).toBe("creative");
  });
});

describe("cost estimation", () => {
  it("prices known models by longest prefix", () => {
    expect(priceFor("gpt-4.1-mini-2025-04-14")).toEqual({ price: { input: 0.4, output: 1.6 }, priced: true });
    expect(estimateCost("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toEqual({ costUsd: 24, priced: true });
  });

  it("falls back conservatively for unknown models and honours overrides", () => {
    expect(estimateCost("mystery", { inputTokens: 1_000_000, outputTokens: 0 })).toEqual({ costUsd: 5, priced: false });
    const overrides = parsePricingOverrides('{"mystery":{"input":1,"output":2}}');
    expect(estimateCost("mystery", { inputTokens: 1_000_000, outputTokens: 1_000_000 }, overrides)).toEqual({ costUsd: 3, priced: true });
    expect(parsePricingOverrides("not json")).toEqual({});
  });
});

describe("calculator tool", () => {
  it("evaluates arithmetic with precedence and functions", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
    expect(evaluate("-2 ^ 2")).toBe(-4);
    expect(evaluate("round(49 * 12 * 0.85, 2)")).toBe(499.8);
    expect(evaluate("max(1, 2, 3) + sqrt(16)")).toBe(7);
  });

  it("rejects anything that is not arithmetic", () => {
    expect(() => evaluate("process.exit(1)")).toThrow();
    expect(() => evaluate("1 / 0")).toThrow(/zero/);
    expect(() => evaluate("2 +")).toThrow();
    expect(() => evaluate("constructor(1)")).toThrow(/Unknown function/);
  });
});

describe("SSRF protection", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("rejects unsafe URLs before any request is made", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow(/internal/);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private/);
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://user:pass@example.com/")).rejects.toThrow(/credentials/);
    await expect(assertPublicUrl("http://service.internal/")).rejects.toThrow(/internal/);
    await expect(assertPublicUrl("not a url")).rejects.toThrow(/Invalid/);
  });
});

describe("invented endpoints", () => {
  it("rejects placeholder hosts so agents cannot act on made-up integrations", () => {
    for (const u of ["https://api.example.com/send", "https://email-campaign-platform.example.com/api", "https://crm.test/x", "https://your-domain.com/api", "https://foo.invalid/"]) {
      expect(isPlaceholderHost(u), u).toBe(true);
    }
    for (const u of ["https://httpbin.org/post", "https://api.github.com/repos", "https://examplecorp.io/"]) {
      expect(isPlaceholderHost(u), u).toBe(false);
    }
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});
