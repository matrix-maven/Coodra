import { createDb, migrateSqlite } from '@coodra/db';
const path = process.argv[2];
const handle = createDb({ mode: 'solo', sqlite: { path, skipPragmas: true } });
if (handle.kind !== 'sqlite') throw new Error('expected sqlite');
migrateSqlite(handle.db);
console.log('migrated:', path);
handle.close();
