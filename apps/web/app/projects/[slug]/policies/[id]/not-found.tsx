import Link from 'next/link';

export default function PolicyNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <h1 className="font-display text-4xl font-black tracking-tight">Policy not found</h1>
      <p className="text-sm text-text-secondary">No policy with that id or name exists.</p>
      <Link href="/policies" className="font-display text-sm font-bold font-medium text-brand hover:text-brand-hover">
        ◂ Return to policies
      </Link>
    </div>
  );
}
