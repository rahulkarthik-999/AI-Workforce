import Link from "next/link";
import { GoalRow } from "@/components/goal-row";
import { EmptyState, Panel } from "@/components/ui";
import { listGoals } from "@/engine/service";
import { pageAuth } from "@/lib/auth";

export const metadata = { title: "Goals" };

export default async function GoalsPage() {
  const { actor } = await pageAuth();
  const goals = await listGoals(actor, 100);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="label">Goals</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Everything the workforce has taken on</h1>
        </div>
        <Link href="/" className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-[13px] font-medium text-accent-ink hover:bg-accent/90">
          New goal
        </Link>
      </header>
      <Panel>
        {goals.length ? (
          <div className="divide-y divide-line">
            {goals.map((g) => (
              <GoalRow key={g.id} goal={g} />
            ))}
          </div>
        ) : (
          <EmptyState title="No goals yet">
            Give the workforce its first goal from the{" "}
            <Link href="/" className="text-fg underline underline-offset-2">
              Command Center
            </Link>
            .
          </EmptyState>
        )}
      </Panel>
    </main>
  );
}
