'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import styles from './GraphReport.module.css';

/**
 * Renders Graphify's `GRAPH_REPORT.md`.
 *
 * Client component for the same reason `WikiReader` is one: `react-markdown`
 * is authored against the classic client runtime. The markdown itself comes
 * from the server component that read the file (bounded there), so the payload
 * is a plain string.
 *
 * No `rehype-raw` — embedded HTML in the report is escaped, not executed. The
 * report is generated from repository contents, so treating it as untrusted
 * input is the correct default even though it is produced locally.
 */

const components: Components = {
  pre: ({ children }) => <pre className={styles.pre}>{children}</pre>,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? '');
    return <code className={isBlock ? styles.codeBlock : styles.codeInline}>{children}</code>;
  },
  a: ({ href, children }) => (
    <a href={href} className={styles.link} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table className={styles.table}>{children}</table>
    </div>
  ),
};

export function GraphReport({ markdown }: { readonly markdown: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
