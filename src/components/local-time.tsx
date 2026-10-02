"use client";

import { useSyncExternalStore } from "react";
import { formatClock, formatRelative } from "@/lib/client";

const noop = () => () => undefined;

/** False during server render and hydration, true afterwards. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

const FORMATTERS = {
  clock: formatClock,
  relative: formatRelative,
  datetime: (iso: string | Date) =>
    new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
};

/**
 * Renders a timestamp in the viewer's own time zone. The server does not know that zone,
 * so the text is filled in after hydration instead of guessing (and mismatching).
 */
export function LocalTime({ value, format = "clock", className }: { value: string | Date; format?: keyof typeof FORMATTERS; className?: string }) {
  const mounted = useMounted();
  const iso = typeof value === "string" ? value : value.toISOString();
  return (
    <time dateTime={iso} className={className}>
      {mounted ? FORMATTERS[format](iso) : " "}
    </time>
  );
}
