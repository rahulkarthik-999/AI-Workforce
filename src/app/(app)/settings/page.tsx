import { Check, Minus } from "lucide-react";
import { SPECIALISTS, AGENTS } from "@/agents/definitions";
import { Panel, RiskBadge } from "@/components/ui";
import { pageAuth } from "@/lib/auth";
import { systemStatus } from "@/lib/system";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, workspace } = await pageAuth();
  const s = systemStatus();
  const limits: [string, string][] = [
    ["Budget per goal", `$${s.limits.goalBudgetUsd.toFixed(2)}`],
    ["Max tasks per goal", String(s.limits.maxTasksPerGoal)],
    ["Max retries per task", String(s.limits.maxTaskRetries)],
    ["Max model calls per agent run", String(s.limits.maxAgentIterations)],
    ["Max replans per goal", String(s.limits.maxReplansPerGoal)],
    ["Parallel tasks", String(s.limits.maxParallelTasks)],
    ["Task timeout", `${s.limits.taskTimeoutSeconds}s`],
    ["Goals per hour", String(s.limits.goalsPerHour)],
  ];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6">
        <p className="label">Settings</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          What this deployment can actually do. Credentials are set as server environment variables and are never sent to the browser - only whether each one is present is shown here.
        </p>
      </header>

      <div className="space-y-6">
        <Panel title="Workspace">
          <dl className="grid gap-x-6 gap-y-3 p-4 text-[13px] sm:grid-cols-2">
            <div>
              <dt className="label">Workspace</dt>
              <dd className="mt-1">{workspace.name}</dd>
            </div>
            <div>
              <dt className="label">Signed in as</dt>
              <dd className="mt-1">
                {user.name} <span className="text-muted">({user.email})</span>
              </dd>
            </div>
            <div>
              <dt className="label">Database</dt>
              <dd className="mt-1">{s.database}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="AI provider">
          <div className="p-4 text-[13px]">
            {s.ai.configured ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <div>
                  <dt className="label">Active provider</dt>
                  <dd className="mt-1 font-mono">{s.ai.provider}</dd>
                </div>
                <div>
                  <dt className="label">Main model</dt>
                  <dd className="mt-1 font-mono">{s.ai.models?.main}</dd>
                </div>
                <div>
                  <dt className="label">Fast model (interpretation, verification)</dt>
                  <dd className="mt-1 font-mono">{s.ai.models?.fast}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-warn">
                Not configured. Set one of <span className="font-mono">{s.ai.envVars.join(", ")}</span> to enable goal execution.
              </p>
            )}
            <p className="mt-3 text-xs leading-relaxed text-faint">
              Choose a provider with <span className="font-mono">AI_PROVIDER</span> (anthropic, openai, deepseek) and models with <span className="font-mono">AI_MODEL</span> / <span className="font-mono">AI_FAST_MODEL</span>. Keys present:{" "}
              {s.ai.available.length ? s.ai.available.join(", ") : "none"}.
            </p>
          </div>
        </Panel>

        <Panel title="Tools">
          <ul className="divide-y divide-line">
            {s.tools.map((t) => (
              <li key={t.name} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${t.available ? "bg-ok/15 text-ok" : "bg-raised text-faint"}`}>
                  {t.available ? <Check className="size-3" aria-label="Available" /> : <Minus className="size-3" aria-label="Not configured" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px]">{t.name}</span>
                    <span className="label">{t.category}</span>
                    <RiskBadge level={t.riskLevel} />
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">{t.description}</p>
                  {!t.available && (
                    <p className="mt-1 text-xs text-warn">
                      {t.reason} Set <span className="font-mono">{t.envVars.join(", ")}</span>. Until then agents are told this tool is unavailable and work without it.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Agents">
          <ul className="divide-y divide-line">
            {[...SPECIALISTS, AGENTS.verification, AGENTS.manager].map((a) => (
              <li key={a.id} className="px-4 py-3">
                <p className="text-[13px] font-medium">{a.name}</p>
                <p className="mt-0.5 text-[13px] text-muted">{a.description}</p>
                {a.tools.length > 0 && <p className="mt-1 font-mono text-[11px] text-faint">{a.tools.join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Safety limits">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4">
            {limits.map(([label, value]) => (
              <div key={label}>
                <dt className="label">{label}</dt>
                <dd className="tabular mt-1 text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-line px-4 py-3 text-xs leading-relaxed text-faint">
            Risk policy: LOW-risk actions run automatically; MEDIUM-risk actions (communications, publishing, changing external systems) pause for approval; HIGH-risk actions (financial, destructive, bulk communication) require explicit reviewed approval.
          </p>
        </Panel>
      </div>
    </main>
  );
}
