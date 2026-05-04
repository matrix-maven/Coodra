import Link from 'next/link';

export default function PackNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <h1 className="font-display text-4xl font-black tracking-tight">Pack not found</h1>
      <p className="text-sm text-text-secondary">
        No feature pack with that slug exists under <span className="font-mono">docs/feature-packs/</span>.
      </p>
      <Link href="/packs" className="font-display text-sm font-bold font-medium text-brand hover:text-brand-hover">
        ◂ Return to packs
      </Link>
    </div>
  );
}
