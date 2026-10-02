"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Button, ErrorNote, inputClass } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signup = mode === "signup";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, { body: Object.fromEntries(form) });
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md bg-accent font-mono text-xs font-bold text-accent-ink">AI</span>
            <span className="text-sm font-semibold tracking-tight">AI Workforce</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{signup ? "Create your workspace" : "Sign in"}</h1>
          <p className="mt-1.5 text-sm text-muted">Tell AI what you want. It figures out how to get it done.</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          {signup && (
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-muted">Name</span>
              <input name="name" required maxLength={80} autoComplete="name" className={inputClass} />
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 block text-[13px] text-muted">Email</span>
            <input name="email" type="email" required autoComplete="email" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] text-muted">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={signup ? 10 : 1}
              autoComplete={signup ? "new-password" : "current-password"}
              className={inputClass}
            />
            {signup && <span className="mt-1.5 block text-xs text-faint">At least 10 characters.</span>}
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            {signup ? "Create workspace" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-[13px] text-muted">
          {signup ? "Already have an account? " : "New here? "}
          <Link href={signup ? "/login" : "/signup"} className="text-fg underline underline-offset-4 hover:text-accent">
            {signup ? "Sign in" : "Create a workspace"}
          </Link>
        </p>
      </div>
    </main>
  );
}
