import { createServer } from 'node:net';

export interface ProbePortResult {
  readonly status: 'green' | 'yellow';
  readonly detail: string;
  readonly remediation?: string;
}

/**
 * Returns:
 *   - green  → port is bindable right now (no service of any kind on it).
 *   - yellow → port is in use; this is fine if it's the coodra daemon
 *              (verify with the corresponding /healthz check), otherwise
 *              the user needs to free it.
 */
export async function probePort(port: number, label: string): Promise<ProbePortResult> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        resolve({
          status: 'yellow',
          detail: `port ${port} is in use (likely ${label} daemon)`,
          remediation: `Confirm via /healthz check, or free the port with \`lsof -i :${port}\`.`,
        });
        return;
      }
      resolve({
        status: 'yellow',
        detail: `port ${port} probe error: ${(err as Error).message}`,
      });
    });
    server.once('listening', () => {
      const addr = server.address();
      server.close(() => {
        resolve({
          status: 'green',
          detail: `port ${port} is free${typeof addr === 'object' && addr !== null ? '' : ''}`,
        });
      });
    });
    try {
      server.listen({ port, host: '127.0.0.1', exclusive: true });
    } catch (err) {
      resolve({ status: 'yellow', detail: `bind threw: ${(err as Error).message}` });
    }
  });
}
