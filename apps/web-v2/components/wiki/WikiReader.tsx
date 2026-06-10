'use client';

import type { WikiPage, WikiStructure } from '@coodra/shared/wiki';
import { isValidElement, type ReactNode, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Mermaid } from './Mermaid';
import styles from './WikiReader.module.css';

export interface WikiPageContentView {
  readonly state: 'pending' | 'authored';
  readonly contentMarkdown: string;
  readonly citations: ReadonlyArray<{ file: string; startLine?: number; endLine?: number }>;
}

export interface WikiReaderProps {
  readonly structure: WikiStructure;
  readonly pages: Record<string, WikiPageContentView>;
}

/** className of a React element child, or '' — used to detect ```mermaid code blocks. */
function classOf(node: ReactNode): string {
  if (isValidElement(node)) {
    const props = node.props as { className?: unknown };
    if (typeof props.className === 'string') return props.className;
  }
  return '';
}

function flattenText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(flattenText).join('');
  if (isValidElement(children)) return flattenText((children.props as { children?: ReactNode }).children);
  return '';
}

const markdownComponents: Components = {
  pre: ({ children }) => {
    const first = Array.isArray(children) ? children[0] : children;
    if (/language-mermaid/.test(classOf(first))) return <>{children}</>;
    return <pre className={styles.pre}>{children}</pre>;
  },
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    if (lang === 'mermaid') return <Mermaid chart={flattenText(children).trim()} />;
    if (lang) return <code className={styles.codeBlock}>{children}</code>;
    return <code className={styles.codeInline}>{children}</code>;
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

interface TreeNode {
  readonly page: WikiPage;
  readonly children: TreeNode[];
}

/** Build the parentId hierarchy — the mind-map. Orphans (dangling parentId) surface at the top. */
function buildTree(structure: WikiStructure): TreeNode[] {
  const byId = new Map<string, WikiPage>(structure.pages.map((p) => [p.id, p]));
  const childrenOf = new Map<string | null, WikiPage[]>();
  for (const p of structure.pages) {
    const key = p.parentId !== null && byId.has(p.parentId) ? p.parentId : null;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(p);
    else childrenOf.set(key, [p]);
  }
  const build = (parentId: string | null): TreeNode[] =>
    (childrenOf.get(parentId) ?? []).map((page) => ({ page, children: build(page.id) }));
  return build(null);
}

const IMPORTANCE_CLASS: Record<WikiPage['importance'], string> = {
  high: styles.dotHigh ?? '',
  medium: styles.dotMedium ?? '',
  low: styles.dotLow ?? '',
};

export function WikiReader({ structure, pages }: WikiReaderProps): React.JSX.Element {
  const tree = useMemo(() => buildTree(structure), [structure]);
  const firstPageId = structure.pages[0]?.id ?? '';
  const [selectedId, setSelectedId] = useState<string>(firstPageId);

  const selectedPage = structure.pages.find((p) => p.id === selectedId) ?? structure.pages[0];
  const selectedContent = selectedPage ? pages[selectedPage.id] : undefined;

  const renderNav = (nodes: TreeNode[], depth: number): React.JSX.Element => (
    <ul className={styles.navList} style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      {nodes.map((node) => {
        const authored = pages[node.page.id]?.state === 'authored';
        const active = node.page.id === selectedId;
        return (
          <li key={node.page.id}>
            <button
              type="button"
              className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
              onClick={() => setSelectedId(node.page.id)}
            >
              <span className={`${styles.dot} ${IMPORTANCE_CLASS[node.page.importance]}`} aria-hidden />
              <span className={authored ? styles.navTitle : styles.navTitlePending}>{node.page.title}</span>
              {!authored && <span className={styles.pendingTag}>draft</span>}
            </button>
            {node.children.length > 0 && renderNav(node.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={styles.layout}>
      <nav className={styles.rail} aria-label="Wiki pages">
        <div className={styles.railHeader}>
          <span className={styles.railTitle}>{structure.title}</span>
          <span className={styles.railMode}>{structure.mode}</span>
        </div>
        {renderNav(tree, 0)}
      </nav>

      <article className={styles.content}>
        {selectedPage ? (
          <>
            <header className={styles.pageHeader}>
              <span className={`${styles.dot} ${IMPORTANCE_CLASS[selectedPage.importance]}`} aria-hidden />
              <h1 className={styles.pageTitle}>{selectedPage.title}</h1>
            </header>
            <p className={styles.pageDesc}>{selectedPage.description}</p>
            {selectedPage.relevantFiles.length > 0 && (
              <div className={styles.fileChips}>
                {selectedPage.relevantFiles.slice(0, 24).map((f) => (
                  <code key={f} className={styles.fileChip}>
                    {f}
                  </code>
                ))}
              </div>
            )}
            <div className={styles.markdown}>
              {selectedContent && selectedContent.state === 'authored' && selectedContent.contentMarkdown.length > 0 ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {selectedContent.contentMarkdown}
                </ReactMarkdown>
              ) : (
                <p className={styles.pendingNote}>
                  This page hasn’t been authored yet. Ask your agent to continue generating the wiki (
                  <code>wiki_save_page</code>), or run <code>coodra wiki status</code>.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className={styles.pendingNote}>This wiki has no pages.</p>
        )}
      </article>
    </div>
  );
}
