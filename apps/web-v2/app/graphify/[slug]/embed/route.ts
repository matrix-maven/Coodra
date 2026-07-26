import { readGraphHtml } from '@/lib/queries/graphify';

/**
 * `GET /graphify/<slug>/embed` — serves the project's Graphify `graph.html`
 * for the sandboxed iframe on `/graphify/<slug>`.
 *
 * The slug is the ONLY caller input; the file path is derived from the
 * registered `projects.cwd` and containment-checked in
 * `lib/queries/graphify.ts::readGraphHtml`. This handler adds the transport
 * hardening on top:
 *
 *   - **CSP.** Graphify's `graph.html` is self-contained apart from one CDN
 *     script — `vis-network@9.1.6` from unpkg, carried with an SRI `integrity`
 *     hash and `crossorigin="anonymous"` (verified against graphify 0.8.27).
 *     So the policy allows inline script/style plus that one host, and nothing
 *     else: `connect-src 'none'` means the document cannot phone home, and
 *     `form-action 'none'` means it cannot POST anywhere. If the machine is
 *     offline the CDN fetch fails and the page renders empty — the detail page
 *     says so rather than pretending the graph is broken.
 *   - **`X-Frame-Options: SAMEORIGIN`** so only our own page can frame it.
 *   - **`nosniff`** + an explicit charset.
 *   - **`no-store`** because the file changes whenever the user rebuilds.
 *
 * The consuming `<iframe>` uses `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, which drops the document into an opaque origin — it
 * cannot reach our cookies, storage, or DOM even though it is served from our
 * host.
 */

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://unpkg.com",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const REASON_STATUS: Record<string, number> = {
  cloud_hosted: 404,
  not_found: 404,
  no_cwd: 404,
  no_artifact: 404,
  outside_root: 403,
  too_large: 413,
};

const REASON_MESSAGE: Record<string, string> = {
  cloud_hosted: 'Graph artifacts live on a developer machine; this deployment has no checkout to read.',
  not_found: 'No such project.',
  no_cwd: 'This project has no recorded root directory. Re-run `coodra init` from the project root.',
  no_artifact: 'No graph.html yet. Run `coodra graphify build` in the project root.',
  outside_root:
    'The recorded Graphify output directory resolves outside the project root — refusing to serve it. Open it locally with `coodra graphify open`.',
  too_large: 'graph.html is too large to embed. Open it locally with `coodra graphify open`.',
};

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const result = await readGraphHtml(decodeURIComponent(slug));

  if (!result.ok) {
    return new Response(REASON_MESSAGE[result.reason] ?? 'Unavailable.', {
      status: REASON_STATUS[result.reason] ?? 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return new Response(result.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'cache-control': 'no-store',
    },
  });
}
