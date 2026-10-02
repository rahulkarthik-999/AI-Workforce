"use client";

import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { LocalTime } from "./local-time";
import { Button, EmptyState, ErrorNote, cx, inputClass } from "./ui";

export type MemoryItem = {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  userId: string | null;
  sourceGoalId: string | null;
  updatedAt: string | Date;
};

type Draft = { id?: string; category: string; title: string; content: string };

export function MemoryManager({ memories, categories }: { memories: MemoryItem[]; categories: { id: string; description: string; private: boolean }[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>("ALL");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = filter === "ALL" ? memories : memories.filter((m) => m.category === filter);
  const count = (c: string) => memories.filter((m) => m.category === c).length;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body = { category: draft.category, title: draft.title, content: draft.content };
      if (draft.id) await api(`/api/memory/${draft.id}`, { method: "PATCH", body });
      else await api("/api/memory", { body });
      setDraft(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: MemoryItem) {
    if (!window.confirm(`Delete "${m.title}"? The workforce will no longer use it.`)) return;
    setError(null);
    try {
      await api(`/api/memory/${m.id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap gap-1.5" role="tablist" aria-label="Memory category">
          {[{ id: "ALL", n: memories.length }, ...categories.map((c) => ({ id: c.id, n: count(c.id) }))].map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={filter === c.id}
              onClick={() => setFilter(c.id)}
              className={cx(
                "rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors",
                filter === c.id ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg",
              )}
            >
              {c.id} <span className="tabular text-faint">{c.n}</span>
            </button>
          ))}
        </div>
        <Button size="sm" variant="primary" onClick={() => setDraft({ category: filter === "ALL" ? "PROJECT" : filter, title: "", content: "" })}>
          <Plus className="size-3.5" aria-hidden /> Add memory
        </Button>
      </div>

      {filter !== "ALL" && <p className="mb-3 text-[13px] text-muted">{categories.find((c) => c.id === filter)?.description}</p>}
      {error && !draft && <ErrorNote className="mb-3">{error}</ErrorNote>}

      {draft && (
        <form onSubmit={save} className="mb-4 space-y-3 rounded-xl border border-line-strong bg-panel p-4">
          <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
            <label className="block">
              <span className="label">Category</span>
              <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className={cx(inputClass, "mt-1")}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Title</span>
              <input required minLength={2} maxLength={140} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={cx(inputClass, "mt-1")} placeholder="e.g. Brand tone" />
            </label>
          </div>
          <label className="block">
            <span className="label">What should the workforce remember?</span>
            <textarea required minLength={2} maxLength={6000} rows={4} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} className={cx(inputClass, "mt-1 resize-y")} />
          </label>
          <p className="text-xs text-faint">
            {categories.find((c) => c.id === draft.category)?.private ? "Private to you. " : "Shared with everyone in this workspace. "}
            Used as context when goals are interpreted, planned and executed.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" busy={busy}>
              {draft.id ? "Save changes" : "Save memory"}
            </Button>
          </div>
        </form>
      )}

      {shown.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {shown.map((m) => (
            <li key={m.id} className="group px-4 py-3.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-accent">{m.category}</span>
                    {m.userId && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                        <Lock className="size-3" aria-hidden /> private
                      </span>
                    )}
                    <span className="text-[11px] text-faint">
                      {m.source === "user" ? "added by you" : m.source === "agent" ? "saved by an agent" : "recorded by the system"} · <LocalTime value={m.updatedAt} format="relative" />
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium">{m.title}</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{m.content}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => setDraft({ id: m.id, category: m.category, title: m.title, content: m.content })} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label={`Edit ${m.title}`}>
                    <Pencil className="size-3.5" />
                  </button>
                  <button onClick={() => remove(m)} className="rounded-md p-1.5 text-muted hover:bg-bad/10 hover:text-bad" aria-label={`Delete ${m.title}`}>
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-line">
          <EmptyState title={filter === "ALL" ? "Memory is empty" : `No ${filter.toLowerCase()} memories`}>
            Add what the workforce should always know - your product, audience, tone, constraints. Results and decisions from completed goals are recorded here automatically.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
