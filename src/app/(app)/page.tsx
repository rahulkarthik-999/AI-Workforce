import { CircleAlert, Inbox } from "lucide-react";
import Link from "next/link";
import { ApprovalList } from "@/components/approval-list";
import { GoalComposer } from "@/components/goal-composer";
import { GoalRow } from "@/components/goal-row";
import { EmptyState, Panel } from "@/components/ui";
import { listGoals, pendingApprovals } from "@/engine/service";
import { pageAuth } from "@/lib/auth";
import { systemStatus } from "@/lib/system";

export const metadata = { title: "Command Center" };

const ACTIVE = ["INTERPRETING", "PLANNING", "RUNNING", "WAITING_APPROVAL", "NEEDS_INPUT"];

export default async function CommandCenter() {
  const { actor, user } = await pageAuth();
  const [goals, approvals] = await Promise.all([listGoals(actor, 12), pendingApprovals(actor)]);
  const status = systemStatus();
  const active = goals.filter((g) => ACTIVE.includes(g.status));
  const recent = goals.filter((g) => !ACTIVE.includes(g.status)).slice(0, 6);
  const notConfigured = status.ai.configured
    ? null
    : `No AI provider is configured. Set one of ${status.ai.envVars.join(", ")} on the server to start goals.`;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6">
        <p className="label">Command Center</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">What should the workforce get done, {user.name.split(" ")[0]}?</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Describe the outcome. It will be interpreted, compiled into a task graph, executed by specialist agents, verified, and reported back - pausing only when something needs your approval.
        </p>
      </header>

      {notConfigured && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4 text-[13px] leading-relaxed text-warn">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">AI provider not configured</p>
            <p className="mt-0.5 text-warn/85">
              {notConfigured}{" "}
              <Link href="/settings" className="underline underline-offset-2">
                View configuration
              </Link>
            </p>
          </div>
        </div>
      )}

      <GoalComposer disabledReason={notConfigured} defaultBudget={status.limits.goalBudgetUsd} />

      <div className="mt-10 grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Panel title="Active goals" aside={<span className="tabular font-mono text-[11px] text-faint">{active.length}</span>}>
            {active.length ? (
              <div className="divide-y divide-line">
                {active.map((g) => (
                  <GoalRow key={g.id} goal={g} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing is running">Start a goal above and its live execution will appear here.</EmptyState>
            )}
          </Panel>

          <Panel
            title="Recent results"
            aside={
              goals.length > 0 && (
                <Link href="/goals" className="text-xs text-muted hover:text-fg">
                  All goals
                </Link>
              )
            }
          >
            {recent.length ? (
              <div className="divide-y divide-line">
                {recent.map((g) => (
                  <GoalRow key={g.id} goal={g} />
                ))}
              </div>
            ) : (
              <EmptyState title="No finished goals yet">Completed goals, their deliverables and next best actions will be listed here.</EmptyState>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-2">
          <p className="label mb-3 flex items-center justify-between">
            Approval queue <span className="tabular text-faint">{approvals.length}</span>
          </p>
          {approvals.length ? (
            <ApprovalList items={approvals.map((a) => ({ approval: a.approval, goal: a.goalObjective ?? a.goalPrompt }))} />
          ) : (
            <div className="rounded-xl border border-dashed border-line">
              <EmptyState title="No approvals waiting" icon={<Inbox className="size-5" />}>
                Low-risk work runs automatically. Communications, publishing, purchases and destructive actions pause here for your decision.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
