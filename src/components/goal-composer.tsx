"use client";

import { ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote } from "./ui";

const EXAMPLES = [
  "Create a launch plan for my SaaS.",
  "Create and launch a YouTube video about AI agents.",
  "Create a marketing campaign for my product.",
  "Build a pricing strategy for a B2B analytics tool.",
];

export function GoalComposer({ disabledReason, defaultBudget }: { disabledReason: string | null; defaultBudget: number }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { goal } = await api<{ goal: { id: string } }>("/api/goals", { body: { prompt: text } });
      router.push(`/goals/${goal.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the goal.");
      setBusy(false);
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-2xl border border-line-strong bg-panel transition-colors focus-within:border-accent/70"
      >
        <label htmlFor="goal" className="sr-only">
          Your goal
        </label>
        <textarea
          id="goal"
          ref={ref}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          maxLength={4000}
          disabled={Boolean(disabledReason) || busy}
          placeholder="What do you want to get done?"
          className="block w-full resize-none bg-transparent px-5 pt-4 text-base leading-relaxed text-fg placeholder:text-faint focus:outline-none disabled:opacity-60 sm:text-lg"
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-3 pl-5">
          <p className="text-xs text-faint">
            Budget cap <span className="tabular text-muted">${defaultBudget.toFixed(2)}</span>
            <span className="hidden sm:inline"> · Ctrl/⌘ + Enter to start</span>
          </p>
          <Button type="submit" variant="primary" busy={busy} disabled={!prompt.trim() || Boolean(disabledReason)}>
            {!busy && <ArrowUp className="size-4" aria-hidden />}
            Start
          </Button>
        </div>
      </form>

      {error && <ErrorNote className="mt-3">{error}</ErrorNote>}

      {!disabledReason && (
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setPrompt(ex);
                ref.current?.focus();
              }}
              className="rounded-full border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
