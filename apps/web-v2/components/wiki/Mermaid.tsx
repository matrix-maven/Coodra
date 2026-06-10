'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Client-side Mermaid renderer for Deep Wiki page diagrams (Module 10).
 *
 * Mermaid manipulates the DOM/SVG, so it must run in the browser. We
 * dynamic-import it inside an effect (never on the server / in the RSC
 * pass) and render the produced SVG into a ref. On a parse error we fall
 * back to showing the raw diagram source so a bad diagram never blanks
 * the page. `securityLevel: 'strict'` sanitises the SVG; the dark theme
 * matches the app's editorial surface.
 */
export function Mermaid({ chart }: { readonly chart: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const safeId = `mmd_${rawId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        const { svg } = await mermaid.render(safeId, chart);
        if (!cancelled && hostRef.current) {
          hostRef.current.innerHTML = svg;
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'diagram render failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, safeId]);

  if (error !== null) {
    return (
      <pre className="wiki-mermaid-fallback" title={`Mermaid error: ${error}`}>
        {chart}
      </pre>
    );
  }
  return <div ref={hostRef} className="wiki-mermaid" role="img" aria-label="diagram" />;
}
