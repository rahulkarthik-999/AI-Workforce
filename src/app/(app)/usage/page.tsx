import { desc, eq, gte, and, sql } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, Panel } from "@/components/ui";
import { getDb, schema } from "@/db";
import { pageAuth } from "@/lib/auth";
import { LocalTime } from "@/components/local-time";
import { formatTokens, formatUsd } from "@/lib/client";

export const metadata = { title: "Usage & logs" };

const windowStart = () => new Date(Date.now() - 30 * 86_400_000);

export default async function UsagePage() {
  const { actor } = await pageAuth();
  const db = await getDb();
  const since = windowStart();
  const ws = eq(schema.usageRecords.workspaceId, actor.workspaceId);

  const [totals, byPurpose, recent, audit] = await Promise.all([
    db
      .select({
        calls: sql<number>`count(*)::int`,
        failed: sql<number>`coalesce(sum(case when ${schema.usageRecords.success} then 0 else 1 end),0)::int`,
        cost: sql<number>`coalesce(sum(${schema.usageRecords.costUsd}),0)::float`,
        input: sql<number>`coalesce(sum(${schema.usageRecords.inputTokens}),0)::int`,
        output: sql<number>`coalesce(sum(${schema.usageRecords.outputTokens}),0)::int`,
      })
      .from(schema.usageRecords)
      .where(and(ws, gte(schema.usageRecords.createdAt, since))),
    db
      .select({
        purpose: schema.usageRecords.purpose,
        model: schema.usageRecords.model,
        calls: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${schema.usageRecords.costUsd}),0)::float`,
        avgMs: sql<number>`coalesce(avg(${schema.usageRecords.durationMs}),0)::int`,
      })
      .from(schema.usageRecords)
      .where(and(ws, gte(schema.usageRecords.createdAt, since)))
      .groupBy(schema.usageRecords.purpose, schema.usageRecords.model)
      .orderBy(desc(sql`sum(${schema.usageRecords.costUsd})`)),
    db.select().from(schema.usageRecords).where(ws).orderBy(desc(schema.usageRecords.createdAt)).limit(40),
    db
      .select({ log: schema.auditLogs, user: schema.users.name })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
      .where(eq(schema.auditLogs.workspaceId, actor.workspaceId))
      .orderBy(desc(schema.auditLogs.id))
      .limit(30),
  ]);
  const t = totals[0] ?? { calls: 0, failed: 0, cost: 0, input: 0, output: 0 };

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6">
        <p className="label">Usage & logs</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Every model call, accounted for</h1>
        <p className="mt-2 text-sm text-muted">Last 30 days. Costs are estimates from token usage at list prices.</p>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Estimated cost", formatUsd(t.cost)],
          ["Model calls", String(t.calls)],
          ["Failed calls", String(t.failed)],
          ["Tokens", `${formatTokens(t.input)} in · ${formatTokens(t.output)} out`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-panel p-4">
            <p className="label">{label}</p>
            <p className="tabular mt-1.5 text-lg font-semibold tracking-tight">{value}</p>
          </div>
        ))}
      </div>

      <div className="space-y-6">
        <Panel title="Spend by purpose">
          {byPurpose.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line">
                    {["Purpose", "Model", "Calls", "Avg latency", "Cost"].map((h) => (
                      <th key={h} className="label px-4 py-2 font-normal last:text-right">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {byPurpose.map((r) => (
                    <tr key={`${r.purpose}-${r.model}`}>
                      <td className="px-4 py-2 font-mono text-xs">{r.purpose}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted">{r.model}</td>
                      <td className="tabular px-4 py-2">{r.calls}</td>
                      <td className="tabular px-4 py-2 text-muted">{(r.avgMs / 1000).toFixed(1)}s</td>
                      <td className="tabular px-4 py-2 text-right">{formatUsd(r.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No usage yet">Model calls made while executing goals are recorded here with tokens, latency and cost.</EmptyState>
          )}
        </Panel>

        <Panel title="Recent model calls">
          {recent.length ? (
            <ul className="divide-y divide-line">
              {recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
                  <LocalTime value={r.createdAt} format="datetime" className="tabular font-mono text-faint" />
                  <span className={`size-1.5 rounded-full ${r.success ? "bg-ok" : "bg-bad"}`} aria-label={r.success ? "succeeded" : "failed"} />
                  <span className="font-mono">{r.purpose}</span>
                  <span className="font-mono text-muted">{r.model}</span>
                  <span className="tabular text-muted">
                    {formatTokens(r.inputTokens)} in · {formatTokens(r.outputTokens)} out · {(r.durationMs / 1000).toFixed(1)}s
                  </span>
                  <span className="tabular ml-auto">
                    {formatUsd(r.costUsd)}
                    {!r.priced && r.success ? "*" : ""}
                  </span>
                  {r.goalId && (
                    <Link href={`/goals/${r.goalId}`} className="text-muted underline underline-offset-2 hover:text-fg">
                      goal
                    </Link>
                  )}
                  {r.error && <span className="w-full text-bad">{r.error}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No model calls recorded" />
          )}
          {recent.some((r) => !r.priced && r.success) && <p className="border-t border-line px-4 py-2 text-[11px] text-faint">* No list price known for this model; a conservative fallback rate was used. Set AI_PRICING_JSON to correct it.</p>}
        </Panel>

        <Panel title="Audit log">
          {audit.length ? (
            <ul className="divide-y divide-line">
              {audit.map(({ log, user }) => (
                <li key={log.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
                  <LocalTime value={log.createdAt} format="datetime" className="tabular font-mono text-faint" />
                  <span className="font-mono">{log.action}</span>
                  <span className="text-muted">{user ?? "system"}</span>
                  {log.targetType === "goal" && log.targetId && (
                    <Link href={`/goals/${log.targetId}`} className="ml-auto text-muted underline underline-offset-2 hover:text-fg">
                      goal
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No audited actions yet" />
          )}
        </Panel>
      </div>
    </main>
  );
}
