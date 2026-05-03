import { open } from 'node:fs/promises';

/**
 * `packages/cli/src/lib/sqlite-magic` — header-byte check for the
 * SQLite v3 file format. Used by `db restore` (M08b S6) to refuse
 * sources that aren't SQLite databases BEFORE we touch the live
 * `~/.contextos/data.db`.
 *
 * The magic string is `"SQLite format 3"` followed by a NUL byte
 * (16 bytes total). Documented at
 * https://www.sqlite.org/fileformat.html §1.3 ("The Database
 * Header"). Every valid SQLite file starts with these 16 bytes
 * regardless of dialect, page size, or version (3.0.0 onwards).
 */

// 53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00 = "SQLite format 3\0"
const SQLITE_MAGIC = Buffer.from('53514c69746520666f726d617420330000', 'hex').subarray(0, 16);

export async function isSqliteFile(path: string): Promise<boolean> {
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(path, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fd.read(buf, 0, 16, 0);
    if (bytesRead !== 16) return false;
    return buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) await fd.close();
  }
}
