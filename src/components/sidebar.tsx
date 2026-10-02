"use client";

import { Activity, BookOpen, Command, ListChecks, LogOut, Settings2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Command Center", icon: Command, match: (p: string) => p === "/" },
  { href: "/goals", label: "Goals", icon: ListChecks, match: (p: string) => p.startsWith("/goals") },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, match: (p: string) => p.startsWith("/approvals") },
  { href: "/memory", label: "Memory", icon: BookOpen, match: (p: string) => p.startsWith("/memory") },
  { href: "/usage", label: "Usage & logs", icon: Activity, match: (p: string) => p.startsWith("/usage") },
  { href: "/settings", label: "Settings", icon: Settings2, match: (p: string) => p.startsWith("/settings") },
];

export function Sidebar({ user, workspace, pendingApprovals }: { user: { name: string; email: string }; workspace: string; pendingApprovals: number }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r border-line bg-panel md:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span className="grid size-7 place-items-center rounded-md bg-accent font-mono text-xs font-bold text-accent-ink">AI</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight tracking-tight">AI Workforce</p>
            <p className="truncate text-[11px] leading-tight text-faint">{workspace}</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2" aria-label="Main">
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
                  active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
                )}
              >
                <item.icon className={cx("size-4", active && "text-accent")} aria-hidden />
                <span className="flex-1">{item.label}</span>
                {item.href === "/approvals" && pendingApprovals > 0 && (
                  <span className="tabular rounded-full bg-warn px-1.5 font-mono text-[10px] font-semibold leading-4 text-bg">{pendingApprovals}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-line p-2">
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-tight">{user.name}</p>
              <p className="truncate text-[11px] leading-tight text-faint">{user.email}</p>
            </div>
            <button onClick={logout} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label="Sign out" title="Sign out">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-panel/95 backdrop-blur md:hidden" aria-label="Main">
        {NAV.slice(0, 5).map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cx("relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px]", active ? "text-accent" : "text-muted")}
            >
              <item.icon className="size-[18px]" aria-hidden />
              {item.label.split(" ")[0]}
              {item.href === "/approvals" && pendingApprovals > 0 && <span className="absolute right-[28%] top-2 size-2 rounded-full bg-warn" />}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
