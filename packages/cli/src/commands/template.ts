import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome } from '../lib/coodra-home.js';
import { listAvailableTemplates } from '../lib/template-paths.js';
import { loadTemplate, TemplateLoadError } from '../lib/templates/load-template.js';
import { commandTitle, pc, terminalWidth } from '../ui/index.js';

/**
 * `coodra template {list|install}` — admin surface for the
 * feature-pack templates library. Module 08b S17.
 *
 * `template list` walks both tiers (user-installed under
 * `~/.coodra/templates/<name>/` + bundled under
 * `<cli-dist>/templates/<name>/`), shows source + name + description
 * + supported languages.
 *
 * `template install <source>` copies a local directory into
 * `~/.coodra/templates/<name>/` so it persists across projects.
 * Refuses to overwrite a bundled template's name (e.g. you can't
 * install a custom `generic` that shadows the bundled one — pick a
 * different name with `--name <override>`).
 *
 * Out of M08b scope (deferred to a future slice):
 *   - `template install <git+https://...>` — cloning a remote template
 *   - `template publish` / registry uploads
 */

const REQUIRED_TEMPLATE_FILES = [
  'template.json',
  'spec.md.tmpl',
  'implementation.md.tmpl',
  'techstack.md.tmpl',
  'meta.json.tmpl',
] as const;

const BUNDLED_TEMPLATE_NAMES = new Set([
  'generic',
  'nextjs-saas',
  'python-fastapi',
  'python-ml',
  'node-monorepo',
  'rust-cli',
  'go-service',
]);

export interface TemplateListOptions {
  readonly json?: boolean;
}

export interface TemplateInstallOptions {
  readonly name?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

export interface TemplateIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
}

export const DEFAULT_TEMPLATE_IO: TemplateIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export async function runTemplateListCommand(options: TemplateListOptions, ioOverride?: TemplateIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_TEMPLATE_IO;
  const json = options.json === true;
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const all = listAvailableTemplates({ coodraHome: homePath });
  const enriched = await Promise.all(
    all.map(async (t) => {
      try {
        const def = await loadTemplate(t.dir);
        return {
          name: t.name,
          source: t.source,
          dir: t.dir,
          description: def.meta.description,
          version: def.meta.version,
          languages: def.meta.languages,
          autoSections: def.meta.autoSections,
        };
      } catch {
        return {
          name: t.name,
          source: t.source,
          dir: t.dir,
          description: '(failed to load)',
          version: '?',
          languages: [],
          autoSections: [],
        };
      }
    }),
  );
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, templates: enriched }, null, 2)}\n`);
  } else {
    io.writeStdout(`${commandTitle('Templates', `${enriched.length} available`, { width: terminalWidth() })}\n`);
    if (enriched.length === 0) {
      io.writeStdout(`${pc.dim('—')} no templates available.\n`);
    } else {
      for (const t of enriched) {
        const sourceTag = t.source === 'user' ? pc.cyan('user') : pc.dim('bundled');
        io.writeStdout(`${pc.bold(t.name)} (${sourceTag}) v${t.version}\n`);
        io.writeStdout(`  ${t.description}\n`);
        if (t.languages.length > 0) io.writeStdout(`  languages: ${t.languages.join(', ')}\n`);
        if (t.autoSections.length > 0) io.writeStdout(`  @auto sections: ${t.autoSections.join(', ')}\n`);
        io.writeStdout(`  ${pc.dim(t.dir)}\n\n`);
      }
    }
  }
  io.exit(EXIT_OK);
}

export async function runTemplateInstallCommand(
  source: string,
  options: TemplateInstallOptions,
  ioOverride?: TemplateIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_TEMPLATE_IO;
  const json = options.json === true;
  if (source.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'template install requires <source>');
  }
  const sourceDir = resolve(source.trim());
  if (!existsSync(sourceDir)) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `source directory ${sourceDir} does not exist`);
  }
  try {
    const stats = await stat(sourceDir);
    if (!stats.isDirectory()) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `${sourceDir} is not a directory`);
    }
  } catch (err) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `cannot stat ${sourceDir}: ${(err as Error).message}`);
  }

  // Validate the template structure before copying.
  for (const fname of REQUIRED_TEMPLATE_FILES) {
    if (!existsSync(join(sourceDir, fname))) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `${sourceDir} is missing required file ${fname}`);
    }
  }

  let template: Awaited<ReturnType<typeof loadTemplate>>;
  try {
    template = await loadTemplate(sourceDir);
  } catch (err) {
    const message = err instanceof TemplateLoadError ? err.message : (err as Error).message;
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, `template validation failed: ${message}`);
  }

  const installName =
    options.name?.trim() !== undefined && options.name.trim().length > 0 ? options.name.trim() : template.meta.name;

  // Refuse to overwrite a bundled template's name.
  if (BUNDLED_TEMPLATE_NAMES.has(installName)) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `cannot install a user template named "${installName}" — that name is reserved by a bundled template. Use --name <override> to install under a different name.`,
    );
  }

  const homePath = io.coodraHome ?? resolveCoodraHome();
  const userTemplatesRoot = join(homePath, 'templates');
  const targetDir = join(userTemplatesRoot, installName);

  if (existsSync(targetDir) && options.force !== true) {
    return surfaceError(
      io,
      json,
      EXIT_USER_RECOVERABLE,
      `user template "${installName}" already exists at ${targetDir}. Pass --force to overwrite.`,
    );
  }

  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir)) {
    await copyFile(join(sourceDir, entry), join(targetDir, entry));
  }

  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        {
          ok: true,
          installed: installName,
          source: sourceDir,
          target: targetDir,
          templateMetaName: template.meta.name,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.writeStdout(`${pc.green('✓')} Installed template "${installName}" at ${targetDir}.\n`);
    if (installName !== template.meta.name) {
      io.writeStdout(
        `  ${pc.dim(`(template.json#name was "${template.meta.name}"; installed under override name "${installName}")`)}\n`,
      );
    }
    io.writeStdout(
      `  Use it: ${pc.cyan(`coodra init --template ${installName}`)} or ${pc.cyan(`coodra pack new <slug> --template ${installName}`)}\n`,
    );
  }
  io.exit(EXIT_OK);
}

function surfaceError(io: TemplateIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(exitCode);
}
