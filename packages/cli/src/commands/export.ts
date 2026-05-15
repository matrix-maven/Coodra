import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { getRunWithEverything } from '@coodra/db';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { renderHtml } from '../lib/export/render-html.js';
import { renderJson } from '../lib/export/render-json.js';
import { renderMarkdown } from '../lib/export/render-markdown.js';
import { renderSlack } from '../lib/export/render-slack.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { pc } from '../ui/index.js';

/**
 * `coodra export <runId> --format markdown|json|html|slack` —
 * read-only assembler. Module 08b S12.
 *
 * Per OQ-7 lock (2026-05-03):
 *   - Non-JSON formats (markdown, html, slack) EXCLUDE policy_decisions
 *     by default. `--include-audit` opts in.
 *   - JSON format ALWAYS includes the full audit trail (machine-readable
 *     consumers want full fidelity). The flag has no effect on JSON.
 *
 * Output destination:
 *   - `--out <path>` writes to disk.
 *   - Otherwise writes to stdout (so `coodra export <runId> --format markdown
 *     | pbcopy` works).
 *   - `--webhook <url>` (Slack format only) POSTs the rendered body as
 *     `{ "text": <body> }` to the URL. If the POST fails, the body is
 *     also printed to stdout so the operator never loses content.
 *
 * Pure read path — no DB mutations.
 */

const VALID_FORMATS = ['markdown', 'json', 'html', 'slack'] as const;
type ValidFormat = (typeof VALID_FORMATS)[number];

export interface ExportOptions {
  readonly format: string;
  readonly out?: string;
  readonly includeAudit?: boolean;
  readonly webhook?: string;
}

export interface ExportIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
  /** Override the fetch impl for tests (--webhook). Default: globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_EXPORT_IO: ExportIO = {
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

export async function runExportCommand(runId: string, options: ExportOptions, ioOverride?: ExportIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_EXPORT_IO;
  if (runId.trim().length === 0) {
    return surfaceError(io, EXIT_USER_RECOVERABLE, 'export requires <runId>');
  }
  if (!VALID_FORMATS.includes(options.format as ValidFormat)) {
    return surfaceError(
      io,
      EXIT_USER_RECOVERABLE,
      `--format must be one of ${VALID_FORMATS.join(', ')} (got "${options.format}")`,
    );
  }
  const format = options.format as ValidFormat;
  const includeAudit = options.includeAudit === true;

  if (options.webhook !== undefined && format !== 'slack') {
    return surfaceError(io, EXIT_USER_RECOVERABLE, '--webhook is only supported with --format slack');
  }

  const homePath = io.coodraHome ?? resolveCoodraHome();
  const handle = await openLocalDb(resolveCoodraDataDb(homePath));
  let body: string;
  try {
    const data = await getRunWithEverything(handle, runId.trim());
    if (data === null) {
      return surfaceError(io, EXIT_USER_RECOVERABLE, `no run with id "${runId}"`);
    }

    switch (format) {
      case 'markdown':
        body = renderMarkdown(data, { includeAudit });
        break;
      case 'json':
        body = renderJson(data); // always includes audit
        break;
      case 'html':
        body = renderHtml(data, { includeAudit });
        break;
      case 'slack':
        body = renderSlack(data, { includeAudit });
        break;
    }
  } finally {
    handle.close();
  }

  // POST to Slack webhook if requested.
  if (options.webhook !== undefined && format === 'slack') {
    const fetchImpl = io.fetchImpl ?? globalThis.fetch;
    let posted = false;
    try {
      const res = await fetchImpl(options.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      if (res.ok) {
        posted = true;
        io.writeStderr(`${pc.green('✓')} Posted to Slack webhook (status ${res.status}).\n`);
      } else {
        io.writeStderr(
          `${pc.yellow('!')} Slack webhook returned ${res.status} ${res.statusText}; printing body to stdout as fallback.\n`,
        );
      }
    } catch (err) {
      io.writeStderr(
        `${pc.yellow('!')} Slack webhook POST failed: ${err instanceof Error ? err.message : String(err)}; printing body to stdout as fallback.\n`,
      );
    }
    if (!posted) {
      io.writeStdout(body);
    }
    io.exit(posted ? EXIT_OK : EXIT_USER_RECOVERABLE);
    return;
  }

  // Write to file or stdout.
  if (options.out !== undefined && options.out.length > 0) {
    const outPath = resolve(options.out);
    await writeFile(outPath, body, 'utf8');
    io.writeStderr(`${pc.green('✓')} Wrote ${body.length} bytes to ${outPath} (format: ${format}).\n`);
    io.exit(EXIT_OK);
    return;
  }
  io.writeStdout(body);
  io.exit(EXIT_OK);
}

function surfaceError(io: ExportIO, exitCode: number, message: string): void {
  io.writeStderr(`${pc.red('error')}: ${message}\n`);
  io.exit(exitCode);
}
