import { notFound } from "next/navigation";
import { GoalView } from "@/components/goal-view";
import type { Snapshot } from "@/components/use-goal";
import { goalSnapshot } from "@/engine/service";
import { pageAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";

export const metadata = { title: "Goal" };

export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await pageAuth();
  const { id } = await params;
  let snapshot;
  try {
    snapshot = await goalSnapshot(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  // Round-trip through JSON so the client receives exactly what the API would send.
  const initial = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  return <GoalView goalId={id} initial={initial} />;
}
