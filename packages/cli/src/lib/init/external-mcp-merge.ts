/**
 * `external-mcp-merge.ts` — shared MCP server entry shapes, consumed by
 * `external-codex-merge.ts`'s TOML writer and `graphify-wire.ts`.
 */

/** stdio MCP server entry shape — `{ command, args?, env? }`. */
export interface ExternalMcpEntry {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

/**
 * Remote (Streamable HTTP / SSE) MCP server entry. Every field is
 * optional so a single type covers any client; the per-client builder
 * emits exactly the keys that client expects.
 */
export interface RemoteMcpEntry {
  readonly type?: string;
  readonly url?: string;
  readonly serverUrl?: string;
  readonly headers?: Record<string, string>;
}

/** Any MCP server entry the 9·Core writers persist — stdio or remote. */
export type McpEntry = ExternalMcpEntry | RemoteMcpEntry;
