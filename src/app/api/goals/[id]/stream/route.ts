import { eventsAfter } from "@/engine/events";
import { getGoal } from "@/engine/service";
import { requireAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const POLL_MS = 1000;
/** Close a little before the platform limit; EventSource reconnects with Last-Event-ID. */
const MAX_STREAM_MS = 270_000;
const TERMINAL = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"];

/**
 * Server-Sent Events stream of a goal's execution log. Events are read from the database,
 * so the stream is correct no matter which server instance is executing the goal, and a
 * reconnecting client resumes exactly where it left off.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let goalId: string;
  let actor: { userId: string; workspaceId: string };
  try {
    ({ actor } = await requireAuth());
    goalId = (await ctx.params).id;
    await getGoal(actor, goalId);
  } catch (err) {
    return errorResponse(err);
  }

  const url = new URL(req.url);
  let cursor = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      send("retry: 1500\n\n");
      let idleTicks = 0;
      try {
        while (!req.signal.aborted && Date.now() - started < MAX_STREAM_MS) {
          const events = await eventsAfter(goalId, cursor);
          for (const e of events) {
            cursor = e.id;
            send(`id: ${e.id}\nevent: execution\ndata: ${JSON.stringify({ id: e.id, taskId: e.taskId, type: e.type, level: e.level, message: e.message, data: e.data, createdAt: e.createdAt })}\n\n`);
          }
          if (events.length === 0) {
            idleTicks++;
            // Comment lines keep proxies from closing an idle connection.
            if (idleTicks % 15 === 0) send(": keep-alive\n\n");
            if (idleTicks % 5 === 0) {
              const goal = await getGoal(actor, goalId);
              if (TERMINAL.includes(goal.status)) {
                send(`event: end\ndata: ${JSON.stringify({ status: goal.status })}\n\n`);
                break;
              }
            }
          } else {
            idleTicks = 0;
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } catch {
        // Client went away or a transient read failed; the client reconnects.
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
