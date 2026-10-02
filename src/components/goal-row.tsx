import Link from "next/link";
import { formatUsd } from "@/lib/client";
import { LocalTime } from "./local-time";
import { ProgressBar, StatusBadge } from "./ui";

export type GoalRowData = {
  id: string;
  prompt: string;
  objective: string | null;
  status: string;
  costUsd: number;
  createdAt: Date | string;
  tasksTotal: number;
  tasksCompleted: number;
};

export function GoalRow({ goal }: { goal: GoalRowData }) {
  const pct = goal.tasksTotal ? Math.round((goal.tasksCompleted / goal.tasksTotal) * 100) : 0;
  const tone = goal.status === "FAILED" ? "bad" : goal.status === "COMPLETED" ? "ok" : goal.status === "RUNNING" ? "run" : "accent";
  return (
    <Link href={`/goals/${goal.id}`} className="group block px-4 py-3.5 transition-colors hover:bg-raised/50">
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 flex-1 truncate text-sm font-medium group-hover:text-accent">{goal.objective ?? goal.prompt}</p>
        <StatusBadge status={goal.status} />
      </div>
      <div className="mt-2.5 flex items-center gap-4">
        <div className="w-28 shrink-0 sm:w-40">
          <ProgressBar percent={pct} tone={tone} />
        </div>
        <p className="tabular flex-1 truncate font-mono text-[11px] text-faint">
          {goal.tasksTotal ? `${goal.tasksCompleted}/${goal.tasksTotal} tasks` : "no tasks yet"} · {formatUsd(goal.costUsd)} · <LocalTime value={goal.createdAt} format="relative" />
        </p>
      </div>
    </Link>
  );
}
