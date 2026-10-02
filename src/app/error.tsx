"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm text-center">
        <p className="label text-bad">Something went wrong</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">This page could not be loaded</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The error has been logged. Your goals and their progress are stored safely and are not affected.
          {error.digest && <span className="mt-1 block font-mono text-xs text-faint">Reference: {error.digest}</span>}
        </p>
        <button onClick={reset} className="mt-5 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent/90">
          Try again
        </button>
      </div>
    </main>
  );
}
