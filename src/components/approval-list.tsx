"use client";

import { useRouter } from "next/navigation";
import { ApprovalCard, type ApprovalCardData } from "./approval-card";

export function ApprovalList({ items }: { items: { approval: ApprovalCardData; goal: string }[] }) {
  const router = useRouter();
  return (
    <div className="space-y-3">
      {items.map(({ approval, goal }) => (
        <ApprovalCard key={approval.id} approval={approval} context={{ goal, showGoalLink: true }} onDecided={() => router.refresh()} />
      ))}
    </div>
  );
}
