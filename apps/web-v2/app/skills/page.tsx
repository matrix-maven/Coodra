import { redirect } from 'next/navigation';

/**
 * `/skills` → `/features`. The "Features" concept was renamed to "Skills"
 * (2026-07); the user-facing labels now say Skills, but the route paths still
 * live under `/features` to keep every existing deep-link and internal `<Link>`
 * working. This redirect covers anyone who reads "Skills" and guesses the URL.
 */
export default function SkillsRedirect() {
  redirect('/features');
}
