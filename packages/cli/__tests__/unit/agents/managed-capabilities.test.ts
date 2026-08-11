import { describe, expect, it } from 'vitest';
import { buildManagedGraphifyMcpEntry } from '../../../src/lib/agents/managed-capabilities.js';

describe('managed agent capabilities', () => {
  it('uses the Windows venv Python path for managed Graphify MCP entries on win32', () => {
    const coodraHome = 'C:\\Users\\alice\\.coodra';

    expect(buildManagedGraphifyMcpEntry(coodraHome, 'win32')).toEqual({
      command: 'C:\\Users\\alice\\.coodra\\graphify-mcp\\.venv\\Scripts\\python.exe',
      args: ['-m', 'graphify.serve', '.coodra/graphify/out/graph.json'],
    });
  });
});
