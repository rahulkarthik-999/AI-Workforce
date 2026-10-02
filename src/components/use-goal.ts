"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GoalSnapshot } from "@/engine/service";
import { api, type Serialized } from "@/lib/client";

export type Snapshot = Serialized<GoalSnapshot>;
export type FeedEvent = Snapshot["events"][number];
export type LiveOutput = Record<string, { iteration: number; text: string }>;

const TERMINAL = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"];
const EXECUTING = ["INTERPRETING", "PLANNING", "RUNNING"];

/**
 * Live view of one goal. State always comes from the server: the snapshot is the persisted
 * truth, and the SSE stream delivers execution events as they are recorded. There are no
 * client-side timers pretending to be progress.
 */
export function useGoal(goalId: string, initial: Snapshot) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial);
  const [live, setLive] = useState<LiveOutput>({});
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cursor = useRef(initial.events.at(-1)?.id ?? 0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Snapshot>(`/api/goals/${goalId}`);
      setSnapshot(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the goal.");
    }
  }, [goalId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 250);
  }, [refresh]);

  const status = snapshot.goal.status;
  const streaming = !TERMINAL.includes(status);

  useEffect(() => {
    if (!streaming) return;
    const source = new EventSource(`/api/goals/${goalId}/stream?after=${cursor.current}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource reconnects on its own
    source.addEventListener("execution", (raw) => {
      const e = JSON.parse((raw as MessageEvent<string>).data) as FeedEvent;
      cursor.current = Math.max(cursor.current, e.id);
      if (e.type === "task.output_delta" && e.taskId) {
        const { delta, iteration } = e.data as { delta: string; iteration: number };
        setLive((prev) => {
          const cur = prev[e.taskId!];
          const text = cur && cur.iteration === iteration ? cur.text + delta : delta;
          return { ...prev, [e.taskId!]: { iteration, text } };
        });
        return;
      }
      if (e.taskId && ["task.completed", "task.failed", "task.retry", "task.cancelled"].includes(e.type)) {
        setLive((prev) => {
          const next = { ...prev };
          delete next[e.taskId!];
          return next;
        });
      }
      scheduleRefresh();
    });
    source.addEventListener("end", () => {
      source.close();
      setConnected(false);
      void refresh();
    });
    return () => {
      source.close();
      setConnected(false);
    };
  }, [goalId, streaming, refresh, scheduleRefresh]);

  // If the goal should be executing but no runner holds it (e.g. a serverless invocation
  // ended), nudge the engine. The endpoint is idempotent and a no-op while a runner is alive.
  const stalled = EXECUTING.includes(status) && !snapshot.goal.executing;
  useEffect(() => {
    if (!EXECUTING.includes(status)) return;
    const kick = () => api(`/api/goals/${goalId}/kick`, { method: "POST", body: {} }).then(() => refresh()).catch(() => undefined);
    const first = stalled ? setTimeout(kick, 4000) : null;
    const interval = setInterval(kick, 20_000);
    return () => {
      if (first) clearTimeout(first);
      clearInterval(interval);
    };
  }, [goalId, status, stalled, refresh]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  return { snapshot, live, connected, streaming, loadError, refresh };
}
