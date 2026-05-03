import Link from 'next/link';

export default function RunNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <h1 className="font-display text-4xl font-black tracking-tight">Run not found</h1>
      <p className="text-sm text-(--color-text-secondary)">No run with that id exists in this project.</p>
      <Link
        href="/runs"
        className="font-display text-sm font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
      >
        ◂ Return to run list
      </Link>
    </div>
  );
}
