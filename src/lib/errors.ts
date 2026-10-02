/** Errors whose message is safe to show to end users. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 503, "not_configured");
    this.name = "ConfigError";
  }
}

export class BudgetExceededError extends AppError {
  constructor(message: string) {
    super(message, 402, "budget_exceeded");
    this.name = "BudgetExceededError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** A message that is safe to persist and display; never includes a stack trace. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 1000);
  return String(err).slice(0, 1000);
}

export async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  parent?.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids come from users; reject malformed ones as "not found" before they reach the database. */
export function assertUuid(id: string, what = "Resource"): void {
  if (!UUID.test(id)) throw new AppError(`${what} not found.`, 404, "not_found");
}
