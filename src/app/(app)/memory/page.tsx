import { desc, eq } from "drizzle-orm";
import { MemoryManager } from "@/components/memory-manager";
import { EmptyState, Panel } from "@/components/ui";
import { getDb, schema } from "@/db";
import { pageAuth } from "@/lib/auth";
import { MEMORY_CATEGORY_INFO, PRIVATE_CATEGORIES, listMemories } from "@/memory/service";

export const metadata = { title: "Memory" };

export default async function MemoryPage() {
  const { actor } = await pageAuth();
  const db = await getDb();
  const [memories, learnings] = await Promise.all([
    listMemories(actor.workspaceId, actor.userId),
    db.select().from(schema.learnings).where(eq(schema.learnings.workspaceId, actor.workspaceId)).orderBy(desc(schema.learnings.createdAt)).limit(30),
  ]);
  const categories = (Object.keys(MEMORY_CATEGORY_INFO) as (keyof typeof MEMORY_CATEGORY_INFO)[]).map((id) => ({
    id,
    description: MEMORY_CATEGORY_INFO[id],
    private: PRIVATE_CATEGORIES.includes(id),
  }));

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6">
        <p className="label">Memory</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">What the workforce knows</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Structured, persistent context used when goals are interpreted, planned and executed. You can inspect, edit and delete everything here.
        </p>
      </header>

      <MemoryManager memories={memories} categories={categories} />

      <Panel title="Learnings from results" className="mt-8">
        {learnings.length ? (
          <ul className="divide-y divide-line">
            {learnings.map((l) => (
              <li key={l.id} className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm font-medium leading-snug">{l.pattern}</p>
                  <span className="tabular shrink-0 font-mono text-[11px] text-muted" title="Confidence assigned when the learning was extracted">
                    confidence {l.confidence.toFixed(2)}
                  </span>
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-[13px] leading-relaxed sm:grid-cols-[7rem_1fr]">
                  <dt className="label pt-0.5">Observation</dt>
                  <dd className="text-muted">{l.observation}</dd>
                  <dt className="label pt-0.5">Context</dt>
                  <dd className="text-muted">{l.context}</dd>
                  <dt className="label pt-0.5">Next time</dt>
                  <dd className="text-fg/90">{l.recommendation}</dd>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No learnings yet">
            After each goal finishes, observations from its execution record are stored here as structured learnings and fed into future planning.
          </EmptyState>
        )}
      </Panel>
    </main>
  );
}
