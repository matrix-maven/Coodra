import Link from 'next/link';

export default function ProjectNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <h1 className="font-display text-4xl font-black tracking-tight">Project not found</h1>
      <p className="text-sm text-text-secondary">No project with that id or slug exists.</p>
      <Link href="/projects" className="font-display text-sm font-bold font-medium text-brand hover:text-brand-hover">
        ◂ Return to projects
      </Link>
    </div>
  );
}
