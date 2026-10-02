"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, RiskBadge, inputClass } from "./ui";

export type ApprovalCardData = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  payload: unknown;
  riskLevel: string;
  goalId: string;
};

function PayloadView({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== "object") return null;
  const entries = Object.entries(payload as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return null;
  return (
    <dl className="space-y-2 rounded-lg border border-line bg-bg p-3">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="label">{key}</dt>
          <dd className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg">
            {typeof value === "string" ? value : Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(", ") : JSON.stringify(value, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalCard({ approval, context, onDecided }: { approval: ApprovalCardData; context?: { goal: string; showGoalLink?: boolean }; onDecided?: () => void }) {
  const [review, setReview] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPROVED" | "REJECTED") {
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/approvals/${approval.id}`, { body: { decision, note: note.trim() || undefined } });
      onDecided?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the decision.");
      setBusy(null);
    }
  }

  const high = approval.riskLevel === "HIGH";
  return (
    <article className={`rounded-xl border bg-panel p-4 ${high ? "border-bad/50" : "border-warn/40"}`}>
      <header className="flex items-start gap-3">
        <ShieldAlert className={`mt-0.5 size-4 shrink-0 ${high ? "text-bad" : "text-warn"}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="label">{approval.kind === "TASK" ? "Task requires approval" : "Action requires approval"}</p>
            <RiskBadge level={approval.riskLevel} />
          </div>
          <h3 className="mt-1.5 text-sm font-semibold leading-snug">{approval.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{approval.summary}</p>
          {context && (
            <p className="mt-1.5 truncate text-xs text-faint">
              Goal:{" "}
              {context.showGoalLink ? (
                <Link href={`/goals/${approval.goalId}`} className="underline underline-offset-2 hover:text-fg">
                  {context.goal}
                </Link>
              ) : (
                context.goal
              )}
            </p>
          )}
        </div>
      </header>

      {review && (
        <div className="mt-3 space-y-3">
          <PayloadView payload={approval.payload} />
          <label className="block">
            <span className="label">Note (optional, shown to the agent on rejection)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={`${inputClass} mt-1`} placeholder="e.g. Wrong audience - exclude trial users" />
          </label>
        </div>
      )}

      {error && <ErrorNote className="mt-3">{error}</ErrorNote>}

      <footer className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setReview((v) => !v)} aria-expanded={review}>
          {review ? "Hide details" : "Review"}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="danger" busy={busy === "REJECTED"} disabled={busy !== null} onClick={() => decide("REJECTED")}>
          Reject
        </Button>
        {/* HIGH risk must be reviewed before it can be approved. */}
        <Button size="sm" variant="primary" busy={busy === "APPROVED"} disabled={busy !== null || (high && !review)} onClick={() => decide("APPROVED")} title={high && !review ? "Review the details first" : undefined}>
          Approve
        </Button>
      </footer>
      {high && !review && <p className="mt-2 text-right text-[11px] text-faint">Review the details to enable approval.</p>}
    </article>
  );
}
