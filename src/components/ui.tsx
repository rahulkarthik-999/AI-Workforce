import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Tone = "neutral" | "run" | "ok" | "warn" | "bad" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  run: "text-run",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  accent: "text-accent",
};
const TONE_BG: Record<Tone, string> = {
  neutral: "bg-faint",
  run: "bg-run",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  accent: "bg-accent",
};

const STATUS: Record<string, { label: string; tone: Tone; live?: boolean }> = {
  INTERPRETING: { label: "Understanding", tone: "run", live: true },
  PLANNING: { label: "Planning", tone: "run", live: true },
  NEEDS_INPUT: { label: "Needs input", tone: "warn" },
  RUNNING: { label: "Running", tone: "run", live: true },
  WAITING_APPROVAL: { label: "Awaiting approval", tone: "warn" },
  COMPLETED: { label: "Completed", tone: "ok" },
  PARTIAL: { label: "Partially completed", tone: "warn" },
  FAILED: { label: "Failed", tone: "bad" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  PENDING: { label: "Queued", tone: "neutral" },
  READY: { label: "Ready", tone: "neutral" },
  BLOCKED: { label: "Blocked", tone: "bad" },
  PASSED: { label: "Verified", tone: "ok" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
  APPROVED: { label: "Approved", tone: "ok" },
  REJECTED: { label: "Rejected", tone: "bad" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  DISMISSED: { label: "Dismissed", tone: "neutral" },
  SUCCEEDED: { label: "Succeeded", tone: "ok" },
  PENDING_APPROVAL: { label: "Awaiting approval", tone: "warn" },
  INTERRUPTED: { label: "Interrupted", tone: "warn" },
};

export function statusMeta(status: string) {
  return STATUS[status] ?? { label: status, tone: "neutral" as Tone };
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] uppercase tracking-wider", TONE_TEXT[m.tone], className)}>
      <span className={cx("size-1.5 rounded-full", TONE_BG[m.tone], m.live && "live-dot")} aria-hidden />
      {m.label}
    </span>
  );
}

const RISK_TONE: Record<string, string> = {
  LOW: "border-line text-muted",
  MEDIUM: "border-warn/40 text-warn",
  HIGH: "border-bad/50 text-bad",
};

export function RiskBadge({ level }: { level: string }) {
  return (
    <span className={cx("rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider", RISK_TONE[level] ?? RISK_TONE.LOW)}>
      {level} risk
    </span>
  );
}

export function Panel({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-line bg-panel", className)}>
      {(title || aside) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="label">{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  busy?: boolean;
};

export function Button({ variant = "secondary", size = "md", busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        variant === "primary" && "bg-accent text-accent-ink hover:bg-accent/90",
        variant === "secondary" && "border border-line-strong bg-raised text-fg hover:border-faint",
        variant === "ghost" && "text-muted hover:bg-raised hover:text-fg",
        variant === "danger" && "border border-bad/40 text-bad hover:bg-bad/10",
        className,
      )}
    >
      {busy && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-sm font-medium text-fg">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cx("rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-[13px] leading-relaxed text-bad", className)}>
      {children}
    </div>
  );
}

export function ProgressBar({ percent, tone = "accent" }: { percent: number; tone?: Tone }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width] duration-500", TONE_BG[tone])} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-accent focus:outline-none";
