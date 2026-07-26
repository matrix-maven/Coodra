import { redirect } from 'next/navigation';

/**
 * `/projects/<slug>/skills` → `/projects/<slug>/features`. Same rationale as
 * the top-level `/skills` redirect: labels say "Skills", routes stay under
 * `/features` so nothing existing breaks.
 */
export default async function ProjectSkillsRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/projects/${encodeURIComponent(slug)}/features`);
}
