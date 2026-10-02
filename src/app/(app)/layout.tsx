import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { pendingApprovals } from "@/engine/service";
import { getAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  const pending = await pendingApprovals(auth.actor);
  return (
    <div className="min-h-dvh">
      <Sidebar user={auth.user} workspace={auth.workspace.name} pendingApprovals={pending.length} />
      <div className="pb-20 md:pb-0 md:pl-56">{children}</div>
    </div>
  );
}
