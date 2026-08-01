'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import styles from '../graphify/GraphReport.module.css';

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

export function WorkPackMarkdown({ markdown }: { readonly markdown: string }) {
  if (markdown.trim().length === 0) {
    return <p style={{ color: 'var(--ink-mute)', margin: 0 }}>No content captured yet.</p>;
  }

  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
