import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/CodeBlock.tsx` — inline mono code surface.
 *
 * Used for project shape JSON, policy snippets, run pack previews.
 * Apply spans `<span class="ck">…</span>` (keyword · phosphor),
 * `<span class="cm">…</span>` (comment · ink-mute),
 * `<span class="cw">…</span>` (warn · crimson),
 * `<span class="cs">…</span>` (string · amber).
 *
 * `dangerouslySetInnerHTML` is supported via `html` for templated cases
 * — otherwise pass `children` as plain text.
 */

export interface CodeBlockProps {
  readonly children?: ReactNode;
  readonly html?: string;
  readonly className?: string;
  readonly size?: 'sm' | 'md';
}

export function CodeBlock({ children, html, className, size = 'md' }: CodeBlockProps) {
  const sizeCls = size === 'sm' ? 'text-[11px]' : 'text-[12px]';
  const cls = `code-block ${sizeCls}${className !== undefined ? ` ${className}` : ''}`;
  if (html !== undefined) {
    // The `html` prop is constructed in TSX from typed values (project slug, ID, mode) — it never
    // takes raw user input. Used so syntax-highlight spans (`.ck`, `.cm`, `.cw`) can be inlined
    // without rebuilding the AST in JSX. Callers that pass user-supplied data MUST sanitize first.
    // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted constant code block markup
    return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre className={cls}>{children}</pre>;
}
