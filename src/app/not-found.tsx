import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm text-center">
        <p className="label">404</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Nothing here</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">This page does not exist, or it belongs to a workspace you do not have access to.</p>
        <Link href="/" className="mt-5 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent/90">
          Back to Command Center
        </Link>
      </div>
    </main>
  );
}
