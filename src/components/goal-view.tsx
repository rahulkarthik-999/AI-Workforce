"use client";

import { ArrowLeft, Check, ChevronRight, CircleAlert, Download, FileText, ImageIcon, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS } from "@/agents/definitions";
import { api, formatDuration, formatTokens, formatUsd } from "@/lib/client";
import { ApprovalCard } from "./approval-card";
import { LocalTime, useMounted } from "./local-time";
import { Markdown } from "./markdown";
import { Button, EmptyState, ErrorNote, Panel, ProgressBar, RiskBadge, StatusBadge, cx, inputClass } from "./ui";
import { useGoal, type Snapshot } from "./use-goal";

type Task = Snapshot["tasks"][number];
type Doc = Snapshot["documents"][number];

const agentName = (id: string | null) => (id && id in AGENTS ? AGENTS[id as keyof typeof AGENTS].name : "Unassigned");

/* ------------------------------------------------------------------ pieces */

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="tabular mt-1 text-sm font-medium" title={hint}>
        {value}
      </p>
    </div>
  );
}

function Questions({ goalId, questions, onDone }: { goalId: string; questions: Snapshot["goal"]["questions"]; onDone: () => void }) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/goals/${goalId}/answers`, { body: { answers: questions.map((q, i) => ({ question: q.question, answer: answers[i] })) } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send answers.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-warn/40 bg-panel p-5">
      <p className="label text-warn">A quick question before work starts</p>
      <p className="mt-1 text-[13px] text-muted">Only what is essential to begin. Everything else will be handled with stated assumptions.</p>
      <div className="mt-4 space-y-4">
        {questions.map((q, i) => (
          <label key={q.question} className="block">
            <span className="text-sm font-medium">{q.question}</span>
            <span className="mt-0.5 block text-xs text-faint">{q.why}</span>
            <input
              required
              maxLength={2000}
              value={answers[i]}
              onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
              className={cx(inputClass, "mt-2")}
            />
          </label>
        ))}
      </div>
      {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
      <div className="mt-4 flex justify-end">
        <Button type="submit" variant="primary" busy={busy}>
          Continue
        </Button>
      </div>
    </form>
  );
}

function FailurePanel({ goalId, error, onDone }: { goalId: string; error: string; onDone: () => void }) {
  const budget = /budget/i.test(error);
  const config = /configured|API key|not set|quota/i.test(error);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [extra, setExtra] = useState("2");

  async function retry() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/goals/${goalId}/resume`, { body: budget ? { addBudgetUsd: Number(extra) || 1 } : {} });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="alert" className="rounded-xl border border-bad/40 bg-bad/5 p-5">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-bad">{budget ? "Budget limit reached" : config ? "Configuration needed" : "Execution stopped"}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-fg/90">{error}</p>
          <p className="mt-1 text-xs text-muted">
            {budget
              ? "Completed work is saved. Add budget to continue from where it stopped."
              : config
                ? "Fix the server configuration, then retry. Completed work is saved."
                : "Completed work is saved. Retrying re-runs only the failed and blocked tasks."}
          </p>
          {err && <ErrorNote className="mt-3">{err}</ErrorNote>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {budget && (
              <label className="flex items-center gap-2 text-[13px] text-muted">
                Add $
                <input type="number" min="0.5" max="100" step="0.5" value={extra} onChange={(e) => setExtra(e.target.value)} className={cx(inputClass, "h-8 w-20 py-1")} />
              </label>
            )}
            <Button size="sm" busy={busy} onClick={retry}>
              {budget ? "Add budget and continue" : "Retry"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ snapshot, onOpenDoc }: { snapshot: Snapshot; onOpenDoc: (d: Doc) => void }) {
  const r = snapshot.result!;
  const s = r.stats;
  const awaiting = snapshot.tasks.filter((t) => t.status === "WAITING_APPROVAL").length;
  return (
    <section className="rounded-xl border border-line-strong bg-panel">
      <div className="border-b border-line p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="label">Result</p>
          <span className={cx("font-mono text-[11px] font-semibold uppercase tracking-wider", snapshot.goal.status === "COMPLETED" ? "text-ok" : snapshot.goal.status === "FAILED" ? "text-bad" : "text-warn")}>
            {r.statusLabel}
          </span>
        </div>
        <h2 className="mt-2 text-lg font-semibold leading-snug tracking-tight">{r.headline}</h2>
        <div className="mt-2 text-muted">
          <Markdown>{r.summary}</Markdown>
        </div>
        {!r.synthesized && <p className="mt-2 text-xs text-warn">Narrative summary unavailable for this run; figures below are measured directly.</p>}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-line p-5 sm:grid-cols-4">
        <Stat label="Tasks" value={`${s.tasksCompleted} of ${s.tasksTotal} completed`} hint={`${s.tasksFailed} failed · ${s.tasksBlocked} blocked · ${s.tasksCancelled} cancelled${awaiting ? ` · ${awaiting} awaiting approval` : ""}`} />
        <Stat label="Execution time" value={formatDuration(s.executionMs)} />
        <Stat label="Estimated AI cost" value={formatUsd(s.costUsd)} hint={`${formatTokens(s.inputTokens)} in · ${formatTokens(s.outputTokens)} out`} />
        <Stat label="Retries" value={String(s.retries)} />
      </div>
      <div className="p-5">
        <p className="label mb-2">Deliverables</p>
        {r.deliverables.length ? (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {r.deliverables.map((d) => {
              const doc = snapshot.documents.find((x) => x.id === d.documentId);
              return (
                <li key={d.documentId}>
                  <button
                    onClick={() => doc && onOpenDoc(doc)}
                    disabled={!doc}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-raised disabled:opacity-60"
                  >
                    <Check className="size-3.5 shrink-0 text-ok" aria-hidden />
                    <span className="truncate">{d.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No deliverables were produced.</p>
        )}
      </div>
    </section>
  );
}

function NextBestAction({ rec, onDone }: { rec: Snapshot["recommendations"][number]; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "APPROVED" | "DISMISSED") {
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/recommendations/${rec.id}`, { body: { decision } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the decision.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="rounded-xl border border-accent/40 bg-accent/[0.04] p-5">
      <p className="label flex items-center gap-1.5 text-accent">
        <Sparkles className="size-3.5" aria-hidden /> Next best action
      </p>
      <h3 className="mt-2 text-base font-semibold leading-snug">{rec.title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{rec.rationale}</p>
      {error && <ErrorNote className="mt-3">{error}</ErrorNote>}
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="primary" busy={busy === "APPROVED"} disabled={busy !== null} onClick={() => decide("APPROVED")}>
          Approve and run
        </Button>
        <Button size="sm" variant="ghost" busy={busy === "DISMISSED"} disabled={busy !== null} onClick={() => decide("DISMISSED")}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}

function LiveTask({ task, text }: { task: Task; text: string | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="border-b border-line p-4 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-run">{agentName(task.assignedAgent)}</p>
        <StatusBadge status="RUNNING" />
      </div>
      <p className="mt-1 text-sm font-medium">{task.title}</p>
      <div ref={box} className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-line bg-bg p-3" aria-live="off">
        {text ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg/85">{text}</pre>
        ) : (
          <p className="font-mono text-xs text-faint">Waiting for output from the model…</p>
        )}
      </div>
    </div>
  );
}

function TaskDetail({ task, snapshot }: { task: Task; snapshot: Snapshot }) {
  const calls = snapshot.toolCalls.filter((c) => c.taskId === task.id);
  const runs = snapshot.runs.filter((r) => r.taskId === task.id);
  const v = task.verification;
  return (
    <div className="space-y-4 border-t border-line bg-bg/40 px-4 py-4 text-[13px]">
      <div>
        <p className="label">Task</p>
        <p className="mt-1 whitespace-pre-wrap leading-relaxed text-fg/90">{task.description}</p>
        <p className="mt-2 leading-relaxed text-muted">
          <span className="text-faint">Acceptance criteria: </span>
          {task.input.acceptanceCriteria}
        </p>
      </div>

      {task.error && task.status !== "COMPLETED" && <ErrorNote>{task.error}</ErrorNote>}

      {v && (
        <div>
          <p className="label">
            Verification · {v.verdict === "PASS" ? "passed" : "failed"} · score {v.score.toFixed(2)} · {v.verifiedBy === "deterministic" ? "automated checks" : "automated checks + Verification Agent"}
          </p>
          <ul className="mt-1.5 space-y-1">
            {v.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                {c.passed ? <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden /> : <X className="mt-0.5 size-3.5 shrink-0 text-bad" aria-hidden />}
                <span className={c.passed ? "text-muted" : "text-fg"}>
                  <span className="font-mono text-xs">{c.name}</span> — {c.detail}
                </span>
              </li>
            ))}
          </ul>
          {v.issues.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-warn">
              {v.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {calls.length > 0 && (
        <div>
          <p className="label">Tool calls</p>
          <ul className="mt-1.5 space-y-1.5">
            {calls.map((c) => (
              <li key={c.id} className="rounded-lg border border-line bg-panel px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs">{c.toolName}</span>
                  <span className="flex items-center gap-2">
                    {c.durationMs != null && <span className="tabular font-mono text-[11px] text-faint">{c.durationMs} ms</span>}
                    <StatusBadge status={c.status} />
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-faint">{JSON.stringify(c.input)}</p>
                {c.error && <p className="mt-1 text-xs text-bad">{c.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <p className="label">Agent runs</p>
          <ul className="tabular mt-1.5 space-y-0.5 font-mono text-[11px] text-muted">
            {runs.map((r) => (
              <li key={r.id}>
                attempt {r.attempt} · {r.status.toLowerCase()} · {r.iterations} model call{r.iterations === 1 ? "" : "s"} · {formatTokens(r.inputTokens)} in / {formatTokens(r.outputTokens)} out · {formatUsd(r.costUsd)}
                {r.completedAt ? ` · ${formatDuration(new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime())}` : ""}
                {r.error ? ` · ${r.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {task.output?.text && (
        <div>
          <p className="label mb-1.5">{task.status === "COMPLETED" ? "Output" : "Last output (not accepted)"}</p>
          <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-line bg-panel p-4">
            <Markdown>{task.output.text}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

function DocumentViewer({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isImage = doc.mimeType.startsWith("image/");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (isImage) return;
    let cancelled = false;
    api<{ document: { content: string } }>(`/api/documents/${doc.id}`)
      .then((r) => !cancelled && setContent(r.document.content))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load the document."));
    return () => {
      cancelled = true;
    };
  }, [doc.id, isImage]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={doc.title} onClick={onClose}>
      <div className="flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-t-2xl border border-line-strong bg-panel sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{doc.title}</h2>
          <a href={`/api/documents/${doc.id}?raw&download`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted hover:bg-raised hover:text-fg">
            <Download className="size-3.5" aria-hidden /> Download
          </a>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <div className="overflow-y-auto p-5">
          {error ? (
            <ErrorNote>{error}</ErrorNote>
          ) : isImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated, dynamically generated asset
            <img src={`/api/documents/${doc.id}?raw`} alt={doc.title} className="mx-auto max-h-[70dvh] rounded-lg" />
          ) : content === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <Markdown>{content}</Markdown>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- main view */

export function GoalView({ goalId, initial }: { goalId: string; initial: Snapshot }) {
  const { snapshot, live, connected, streaming, loadError, refresh } = useGoal(goalId, initial);
  const { goal, tasks } = snapshot;
  const [open, setOpen] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow(streaming);
  const mounted = useMounted();

  const completed = tasks.filter((t) => t.status === "COMPLETED").length;
  const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const running = tasks.filter((t) => t.status === "RUNNING");
  const pendingApprovals = snapshot.approvals.filter((a) => a.status === "PENDING");
  const pendingRec = snapshot.recommendations.find((r) => r.status === "PENDING");
  const started = new Date(goal.startedAt ?? goal.createdAt).getTime();
  const elapsed = (goal.completedAt ? new Date(goal.completedAt).getTime() : now) - started;
  const terminal = !streaming;

  // Group tasks into stages by dependency depth so the graph reads top to bottom.
  const stages = useMemo(() => {
    const deps = new Map<string, string[]>();
    for (const d of snapshot.dependencies) deps.set(d.taskId, [...(deps.get(d.taskId) ?? []), d.dependsOnTaskId]);
    const depth = new Map<string, number>();
    const visit = (id: string, seen: Set<string>): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = 1 + Math.max(0, ...(deps.get(id) ?? []).map((x) => visit(x, seen)));
      depth.set(id, d);
      return d;
    };
    const out = new Map<number, Task[]>();
    for (const t of tasks) {
      const d = visit(t.id, new Set());
      out.set(d, [...(out.get(d) ?? []), t]);
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks, snapshot.dependencies]);

  const titleById = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const depsOf = (id: string) => snapshot.dependencies.filter((d) => d.taskId === id).map((d) => titleById.get(d.dependsOnTaskId) ?? "?");

  const agents = useMemo(() => {
    const by = new Map<string, Task[]>();
    for (const t of tasks) if (t.assignedAgent) by.set(t.assignedAgent, [...(by.get(t.assignedAgent) ?? []), t]);
    return [...by.entries()].map(([id, ts]) => {
      const has = (s: string) => ts.some((t) => t.status === s);
      const state = has("RUNNING")
        ? "RUNNING"
        : has("WAITING_APPROVAL")
          ? "WAITING_APPROVAL"
          : ts.every((t) => t.status === "COMPLETED")
            ? "COMPLETED"
            : has("PENDING") || has("READY")
              ? "PENDING"
              : has("FAILED")
                ? "FAILED"
                : has("BLOCKED")
                  ? "BLOCKED"
                  : "CANCELLED";
      return { id, state, done: ts.filter((t) => t.status === "COMPLETED").length, total: ts.length };
    });
  }, [tasks]);

  async function cancel() {
    if (!window.confirm("Cancel this goal? Running work stops and pending approvals expire. Completed outputs are kept.")) return;
    setCancelling(true);
    setActionError(null);
    try {
      await api(`/api/goals/${goalId}/cancel`, { method: "POST", body: {} });
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel the goal.");
    } finally {
      setCancelling(false);
    }
  }

  const phaseNote =
    goal.status === "INTERPRETING" ? "Understanding your goal…" : goal.status === "PLANNING" ? (tasks.length ? "Planning follow-up tasks…" : "Compiling the task graph…") : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <Link href="/goals" className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden /> All goals
      </Link>

      {/* Current goal */}
      <header className="rounded-xl border border-line bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="label">Current goal</p>
            <h1 className="mt-1.5 text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{goal.objective ?? goal.prompt}</h1>
            {goal.objective && goal.objective !== goal.prompt && <p className="mt-1 text-[13px] text-faint">“{goal.prompt}”</p>}
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={goal.status} />
            {!terminal && (
              <Button size="sm" variant="ghost" busy={cancelling} onClick={cancel}>
                Cancel
              </Button>
            )}
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between">
            <p className="label">Progress</p>
            <p className="tabular font-mono text-xs text-muted">
              {tasks.length ? `${completed}/${tasks.length} tasks · ${percent}%` : (phaseNote ?? "—")}
            </p>
          </div>
          <ProgressBar percent={percent} tone={goal.status === "FAILED" ? "bad" : goal.status === "COMPLETED" ? "ok" : "accent"} />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="Elapsed" value={mounted || goal.completedAt ? formatDuration(elapsed) : "—"} />
          <Stat
            label="Estimated AI cost"
            value={`${formatUsd(goal.costUsd)} / ${formatUsd(goal.budgetUsd)}`}
            hint={snapshot.usage.unpriced ? "Includes calls to a model without a known price (conservative fallback rate used)." : "Estimated from token usage at list prices."}
          />
          <Stat label="Tokens" value={`${formatTokens(snapshot.usage.inputTokens)} in · ${formatTokens(snapshot.usage.outputTokens)} out`} hint={`${snapshot.usage.calls} model calls`} />
          <Stat label="Stream" value={terminal ? "Closed" : connected ? "Live" : "Reconnecting…"} />
        </div>

        {goal.interpretation && (goal.interpretation.constraints.length > 0 || goal.interpretation.target || goal.interpretation.deadline) && (
          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line pt-4">
            {goal.interpretation.target && <span className="rounded-md border border-line px-2 py-1 text-xs text-muted">Target: {goal.interpretation.target}</span>}
            {goal.interpretation.deadline && <span className="rounded-md border border-line px-2 py-1 text-xs text-muted">Deadline: {goal.interpretation.deadline}</span>}
            {goal.interpretation.constraints.map((c) => (
              <span key={c} className="rounded-md border border-line px-2 py-1 text-xs text-muted">
                {c}
              </span>
            ))}
          </div>
        )}
      </header>

      {(loadError || actionError) && <ErrorNote className="mt-4">{loadError ?? actionError}</ErrorNote>}

      <div className="mt-4 space-y-4">
        {goal.status === "NEEDS_INPUT" && goal.questions.length > 0 && <Questions goalId={goalId} questions={goal.questions} onDone={refresh} />}
        {goal.status === "FAILED" && goal.error && <FailurePanel goalId={goalId} error={goal.error} onDone={refresh} />}
        {snapshot.result && terminal && <ResultCard snapshot={snapshot} onOpenDoc={setDoc} />}
        {pendingRec && terminal && goal.status !== "CANCELLED" && <NextBestAction rec={pendingRec} onDone={refresh} />}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {running.length > 0 && (
            <Panel title="Current task" aside={<span className="tabular font-mono text-[11px] text-faint">{running.length} running</span>}>
              {running.map((t) => (
                <LiveTask key={t.id} task={t} text={live[t.id]?.text} />
              ))}
            </Panel>
          )}

          <Panel title="Task graph" aside={tasks.length > 0 && <span className="tabular font-mono text-[11px] text-faint">{stages.length} stage{stages.length === 1 ? "" : "s"}</span>}>
            {tasks.length === 0 ? (
              <EmptyState title={phaseNote ?? (goal.status === "NEEDS_INPUT" ? "Waiting for your answer" : "No tasks were planned")}>
                {phaseNote ? "The plan appears here as soon as the Goal Compiler finishes." : goal.status === "NEEDS_INPUT" ? "Planning starts as soon as you answer above." : undefined}
              </EmptyState>
            ) : (
              <ol>
                {stages.map(([depth, stageTasks]) => (
                  <li key={depth} className="border-b border-line last:border-b-0">
                    <p className="label px-4 pt-3 text-faint">
                      Stage {depth}
                      {stageTasks.length > 1 ? " · parallel" : ""}
                    </p>
                    <ul>
                      {stageTasks.map((t) => {
                        const isOpen = open === t.id;
                        const deps = depsOf(t.id);
                        return (
                          <li key={t.id}>
                            <button
                              onClick={() => setOpen(isOpen ? null : t.id)}
                              aria-expanded={isOpen}
                              className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/50"
                            >
                              <ChevronRight className={cx("mt-0.5 size-4 shrink-0 text-faint transition-transform", isOpen && "rotate-90")} aria-hidden />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                  <p className="text-sm font-medium">{t.title}</p>
                                  <StatusBadge status={t.status} />
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-faint">
                                  <span className="text-muted">{agentName(t.assignedAgent)}</span>
                                  {t.riskLevel !== "LOW" && <RiskBadge level={t.riskLevel} />}
                                  {t.verificationStatus === "PASSED" && <span className="text-ok">verified</span>}
                                  {t.verificationStatus === "FAILED" && t.status !== "COMPLETED" && <span className="text-warn">verification failed</span>}
                                  {t.retryCount > 0 && <span>{t.retryCount} retr{t.retryCount === 1 ? "y" : "ies"}</span>}
                                  {t.costUsd > 0 && <span className="tabular font-mono">{formatUsd(t.costUsd)}</span>}
                                  {deps.length > 0 && <span className="truncate">after: {deps.join(", ")}</span>}
                                </div>
                              </div>
                            </button>
                            {isOpen && <TaskDetail task={t} snapshot={snapshot} />}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          {snapshot.requirements.length > 0 && (
            <Panel title="Requirements">
              <ul className="divide-y divide-line">
                {snapshot.requirements.map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <p className="text-[13px] font-medium">{r.title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{r.description}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <p className="label mb-2 flex items-center justify-between px-1">
              Approval queue <span className="tabular text-faint">{pendingApprovals.length}</span>
            </p>
            {pendingApprovals.length ? (
              <div className="space-y-3">
                {pendingApprovals.map((a) => (
                  <ApprovalCard key={a.id} approval={a} onDecided={refresh} />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[13px] text-muted">Nothing needs your approval.</p>
            )}
          </div>

          <Panel title="Agents">
            {agents.length ? (
              <ul className="divide-y divide-line">
                {agents.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="text-[13px]">{agentName(a.id)}</span>
                    <span className="flex items-center gap-2.5">
                      <span className="tabular font-mono text-[11px] text-faint">
                        {a.done}/{a.total}
                      </span>
                      <StatusBadge status={a.state} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-center text-[13px] text-muted">The Manager assigns specialists once the plan is compiled.</p>
            )}
          </Panel>

          <Panel title="Deliverables" aside={<span className="tabular font-mono text-[11px] text-faint">{snapshot.documents.length}</span>}>
            {snapshot.documents.length ? (
              <ul className="divide-y divide-line">
                {snapshot.documents.map((d) => (
                  <li key={d.id}>
                    <button onClick={() => setDoc(d)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-raised/50">
                      {d.mimeType.startsWith("image/") ? <ImageIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <FileText className="size-4 shrink-0 text-faint" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate text-[13px]">{d.title}</span>
                      <span className="tabular font-mono text-[11px] text-faint">{d.size > 1024 ? `${Math.round(d.size / 1024)} KB` : `${d.size} B`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-center text-[13px] text-muted">Verified outputs are saved here as they complete.</p>
            )}
          </Panel>

          <Panel title="Activity">
            {snapshot.events.length ? (
              <ol className="max-h-[28rem] space-y-2 overflow-y-auto p-4" aria-live="polite">
                {[...snapshot.events].reverse().map((e) => (
                  <li key={e.id} className="flex gap-2.5 text-xs leading-relaxed">
                    <LocalTime value={e.createdAt} className="tabular shrink-0 font-mono text-faint" />
                    <span className={cx("min-w-0 break-words", e.level === "error" ? "text-bad" : e.level === "warn" ? "text-warn" : "text-fg/85")}>{e.message}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="px-4 py-5 text-center text-[13px] text-muted">No activity yet.</p>
            )}
          </Panel>
        </div>
      </div>

      {doc && <DocumentViewer doc={doc} onClose={() => setDoc(null)} />}
    </main>
  );
}
