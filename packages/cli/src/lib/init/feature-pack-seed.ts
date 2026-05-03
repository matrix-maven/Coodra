import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { replaceAutoSections } from '../auto-marker/index.js';
import type { Language } from '../detect.js';
import type { TemplateDefinition } from '../templates/load-template.js';
import { renderTemplate } from '../templates/render.js';
import { populateAutoSections } from './auto-populate.js';
import type { WriteOutcome } from './types.js';

export interface SeedFeaturePackOptions {
  readonly cwd: string;
  readonly slug: string;
  readonly languages: readonly Language[];
  readonly force: boolean;
  readonly dryRun: boolean;
  /**
   * Module 08b S13 — when provided, the template is rendered + its
   * output replaces the built-in buildXSkeleton helpers. Detection is
   * the responsibility of the caller (init resolves --template <name>
   * → TemplateDefinition before passing in here). Auto-section
   * population (M08b S15 --mode auto) layers on top of this output.
   */
  readonly template?: TemplateDefinition;
  /**
   * Module 08b S15 — when true (set by `init --mode auto`), the rendered
   * template's `<!-- @auto:* -->` sections are populated from project
   * shape (deps from package.json/pyproject.toml/Cargo.toml/go.mod;
   * directory tree to depth 3; etc.) before write. Requires
   * `template !== undefined`; no-op without a template since the
   * legacy skeletons don't carry auto-section markers.
   */
  readonly autoPopulate?: boolean;
}

const LANGUAGE_GLOB: Record<Language, string[]> = {
  typescript: ['**/*.ts', '**/*.tsx'],
  javascript: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  python: ['**/*.py'],
  rust: ['**/*.rs'],
  go: ['**/*.go'],
  java: ['**/*.java'],
  ruby: ['**/*.rb'],
};

export async function seedFeaturePack(options: SeedFeaturePackOptions): Promise<WriteOutcome[]> {
  const dir = join(options.cwd, 'docs', 'feature-packs', options.slug);
  const metaPath = join(dir, 'meta.json');
  const specPath = join(dir, 'spec.md');
  const implementationPath = join(dir, 'implementation.md');
  const techstackPath = join(dir, 'techstack.md');
  const outcomes: WriteOutcome[] = [];

  if (!options.dryRun) await mkdir(dir, { recursive: true });

  // Module 08b S13: when --template is supplied, render the template's
  // four .tmpl files instead of the built-in skeletons. The legacy
  // skeleton path is preserved for `init` invocations without --template.
  let metaBody: string;
  let specBody: string;
  let implementationBody: string;
  let techstackBody: string;
  if (options.template !== undefined) {
    const rendered = renderTemplate(options.template, {
      slug: options.slug,
      languages: options.languages,
    });
    metaBody = rendered['meta.json'];
    specBody = rendered['spec.md'];
    implementationBody = rendered['implementation.md'];
    techstackBody = rendered['techstack.md'];
    // Module 08b S15: if autoPopulate, walk each rendered file and
    // replace `<!-- @auto:* -->` section content with project-shape-
    // derived content. Empty/no-data sections get a placeholder
    // line so they stay explicitly marked rather than going blank.
    if (options.autoPopulate === true && options.template.meta.autoSections.length > 0) {
      const populated = populateAutoSections(options.cwd, options.template.meta.autoSections);
      const replacements = Object.fromEntries(Object.entries(populated).map(([k, v]) => [k, { content: `\n${v}\n` }]));
      specBody = replaceAutoSections(specBody, replacements).markdown;
      implementationBody = replaceAutoSections(implementationBody, replacements).markdown;
      techstackBody = replaceAutoSections(techstackBody, replacements).markdown;
      // meta.json doesn't carry auto sections in any current template;
      // skip the markup pass for it.
    }
  } else {
    const sourceFiles = options.languages.flatMap((lang) => LANGUAGE_GLOB[lang]);
    const meta = {
      slug: options.slug,
      parentSlug: null,
      sourceFiles: sourceFiles.length > 0 ? sourceFiles : ['**/*'],
      isActive: true,
    };
    metaBody = `${JSON.stringify(meta, null, 2)}\n`;
    specBody = buildSpecSkeleton(options.slug);
    implementationBody = buildImplementationSkeleton(options.slug);
    techstackBody = buildTechstackSkeleton(options.slug, options.languages);
  }

  // Phase 3 Fix C (2026-05-02): seed implementation.md + techstack.md
  // alongside spec.md + meta.json. Pre-Phase-3 only meta.json + spec.md
  // were written, but apps/mcp-server/src/lib/feature-pack.ts:139-144
  // requires all four files (Promise.all → ENOENT on missing). Result:
  // every fresh `contextos init` shipped with `get_feature_pack` broken
  // out of the gate. Hooks-bridge tolerates missing optional files via
  // its own readMaybe loader, but the MCP-side roundtrip did not.
  outcomes.push(await writeIfAbsent(metaPath, metaBody, options));
  outcomes.push(await writeIfAbsent(specPath, specBody, options));
  outcomes.push(await writeIfAbsent(implementationPath, implementationBody, options));
  outcomes.push(await writeIfAbsent(techstackPath, techstackBody, options));
  return outcomes;
}

async function writeIfAbsent(
  path: string,
  body: string,
  options: { force: boolean; dryRun: boolean },
): Promise<WriteOutcome> {
  const exists = await pathExists(path);
  if (!exists) {
    if (!options.dryRun) await writeFile(path, body, 'utf8');
    return { path, action: 'wrote' };
  }
  if (options.force) {
    if (!options.dryRun) await writeFile(path, body, 'utf8');
    return { path, action: 'forced' };
  }
  return { path, action: 'unchanged', notes: 'file exists; pass --force to overwrite' };
}

function buildSpecSkeleton(slug: string): string {
  return [
    `# ${slug} — Spec`,
    '',
    '> **Status:** TODO — fill in after first implementation pass.',
    '',
    '## 1. What it is',
    '',
    'TODO',
    '',
    '## 2. Acceptance criteria',
    '',
    '- [ ] TODO',
    '',
    '## 3. Non-goals',
    '',
    'TODO',
    '',
  ].join('\n');
}

function buildImplementationSkeleton(slug: string): string {
  return [
    `# ${slug} — Implementation`,
    '',
    '> **Status:** TODO — fill in once a first implementation slice lands.',
    '',
    '## 1. Architecture summary',
    '',
    'TODO — describe the load-bearing modules and how they fit together.',
    '',
    '## 2. Build order',
    '',
    '- [ ] TODO',
    '',
    '## 3. Key risks',
    '',
    'TODO',
    '',
  ].join('\n');
}

function buildTechstackSkeleton(slug: string, languages: readonly Language[]): string {
  const detectedLanguages = languages.length > 0 ? languages.join(', ') : 'TODO (no languages detected at init time)';
  return [
    `# ${slug} — Tech Stack`,
    '',
    '> **Status:** TODO — fill in once tech choices are pinned.',
    '',
    '## 1. Languages detected at init',
    '',
    `- ${detectedLanguages}`,
    '',
    '## 2. Frameworks / runtimes',
    '',
    'TODO',
    '',
    '## 3. External services',
    '',
    'TODO',
    '',
    '## 4. Pinned dependencies (and why)',
    '',
    'TODO',
    '',
  ].join('\n');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
