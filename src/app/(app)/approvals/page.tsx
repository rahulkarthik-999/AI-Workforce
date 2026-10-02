import { desc, eq, and, ne } from "drizzle-orm";
import { Inbox } from "lucide-react";
import Link from "next/link";
import { ApprovalList } from "@/components/approval-list";
import { EmptyState, Panel, RiskBadge, StatusBadge } from "@/components/ui";
import { getDb, schema } from "@/db";
import { pendingApprovals } from "@/engine/service";
import { pageAuth } from "@/lib/auth";
import { LocalTime } from "@/components/local-time";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const { actor } = await pageAuth();
  const db = await getDb();
  const [pending, history] = await Promise.all([
    pendingApprovals(actor),
    db
      .select({ approval: schema.approvals, decidedBy: schema.users.name })
      .from(schema.approvals)
      .leftJoin(schema.users, eq(schema.users.id, schema.approvals.decidedById))
      .where(and(eq(schema.approvals.workspaceId, actor.workspaceId), ne(schema.approvals.status, "PENDING")))
      .orderBy(desc(schema.approvals.createdAt))
      .limit(30),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6">
        <p className="label">Approvals</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Actions waiting for your decision</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Medium and high-risk actions never execute on their own. Work pauses here and resumes the moment you decide.
        </p>
      </header>

      {pending.length ? (
        <ApprovalList items={pending.map((a) => ({ approval: a.approval, goal: a.goalObjective ?? a.goalPrompt }))} />
      ) : (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState title="You're all caught up" icon={<Inbox className="size-5" />}>
            Nothing needs approval right now.
          </EmptyState>
        </div>
      )}

      <Panel title="Decision history" className="mt-8">
        {history.length ? (
          <ul className="divide-y divide-line">
            {history.map(({ approval: a, decidedBy }) => (
              <li key={a.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/goals/${a.goalId}`} className="min-w-0 flex-1 truncate text-[13px] hover:text-accent">
                    {a.title}
                  </Link>
                  <StatusBadge status={a.status} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                  <RiskBadge level={a.riskLevel} />
                  <span>
                    {decidedBy ? `${decidedBy} · ` : ""}
                    <LocalTime value={a.decidedAt ?? a.createdAt} format="relative" />
                  </span>
                  {a.decisionNote && <span className="truncate text-muted">“{a.decisionNote}”</span>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No decisions recorded yet" />
        )}
      </Panel>
    </main>
  );
}
