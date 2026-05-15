Here is the requested reference document in Markdown. It covers each external dependency mentioned in `system-architecture.md`, with usage-focused snippets, config shapes, and explicit flags where behavior, versions, or assumptions require manual verification. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

***

# External API & Library Reference

## Databases, Extensions & ORM Layer

### SQLite

**Version:** Not pinned in architecture; use latest stable 3.x from your OS package manager or `sqlite.org` downloads (verify exact version in your environment).  
**Install:**  
- macOS (Homebrew): `brew install sqlite`  
- Ubuntu/Debian: `sudo apt-get install sqlite3`  
**Docs:** <https://sqlite.org/docs.html>

#### Features used in the architecture

##### WAL mode and performance PRAGMAs

The solo-mode database is `~/.coodra/data.db` with WAL and performance PRAGMAs. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
```

- `journal_mode = WAL` enables concurrent readers with a single writer, which matches the design assumption that Hooks Bridge writes while MCP and Web App read. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)
- `synchronous = NORMAL` relaxes fsync frequency but is recommended in SQLite docs for WAL as a durability/performance trade-off.  
- `cache_size = -64000` configures a 64 MB in-memory page cache; negative value means kibibytes. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

**Gotchas & caveats**

- WAL mode requires that all processes accessing the DB use the same SQLite version and have write access to the DB directory; mismatched access (e.g., a tool that opens DB in `DELETE` mode) can break concurrency.  
- On network filesystems (NFS, SMB), WAL is not recommended; the architecture assumes a local filesystem. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)
- Only one writer is allowed at a time; at 1–10 dev scale this is fine but long-running write-heavy jobs would serialize.  

**Incompatibilities**

- WAL journal mode is not supported on older or heavily sandboxed SQLite builds; confirm `PRAGMA journal_mode` actually returns `wal` on startup.  

***

### sqlite-vec

**Version:** `0.1.9` — pinned **exact** in `packages/db/package.json` (no caret). 0.x packages do not follow semver; a minor bump can and has added column syntax. The matching platform binary ships as an `optionalDependencies` entry (e.g. `sqlite-vec-darwin-arm64@0.1.9`), resolved automatically by pnpm from the parent `sqlite-vec` package.
**Install:**

```bash
pnpm --filter @coodra/db add sqlite-vec@0.1.9 --save-exact
```

**Node.js load pattern** (what `createSqliteDb` does, guarded by the strict-vs-WARN contract below):

```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database(path);
sqliteVec.load(db);   // throws if the platform binary is missing
```

**Docs:** <https://alexgarcia.xyz/sqlite-vec/> · <https://github.com/asg017/sqlite-vec>

#### vec0 virtual table (what Coodra writes)

Module 02 migration `0001_chief_turbo.sql` creates:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS context_packs_vec USING vec0(
  context_pack_id TEXT PRIMARY KEY,
  embedding       FLOAT[384]
);
```

`sqlite-vec@0.1.9` does **not** accept `distance_metric=cosine` as an inline column modifier. The default distance for `FLOAT[N]` columns is L2; for cosine similarity, we normalise vectors to unit length before inserting and rely on the `vec_distance_cosine(a, b)` scalar function in ad-hoc queries. The HNSW-cosine cloud index lives on the Postgres side (`context_packs_embedding_hnsw_idx`, migration 0001, preserve-block).

**Insert + KNN from Node:**

```ts
// JSON-text form is the canonical input — sidesteps any ambiguity around
// how better-sqlite3 binds typed-array buffers into BLOB parameters.
const vec = `[${values.join(',')}]`;

db.prepare(
  'INSERT INTO context_packs_vec(context_pack_id, embedding) VALUES (?, ?)',
).run(packId, vec);

const rows = db
  .prepare(
    `SELECT context_pack_id, distance
       FROM context_packs_vec
       WHERE embedding MATCH ?
         AND k = ?
       ORDER BY distance`,
  )
  .all(vec, 5);
```

#### Strict-vs-WARN load contract (decision 2026-04-22 22:08)

`packages/db/src/client.ts::loadSqliteVecOrFail` attempts `sqliteVec.load(db)` and handles failure based on the environment:

- `NODE_ENV=test` **or** `COODRA_REQUIRE_VEC=1` → throw `InternalError('sqlite_vec_unavailable')` and refuse the SQLite handle. Dev and CI must never silently degrade to the LIKE-over-`content_excerpt` fallback, because that would hide embedding-index regressions.
- otherwise → log a structured WARN tagged `sqlite_vec_unavailable` with `{ loadablePath, platform, arch, err }` and continue. This is the production fail-open path (§7 of `system-architecture.md`): the server still serves contextual reads and falls back to LIKE search.

**Gotchas & caveats**

- **Dimension changes require recreation.** `FLOAT[N]` is baked into the vtab schema; changing `EMBEDDING_DIM` (from `@coodra/shared/constants`) means a migration + full re-embed. The `packages/shared/src/constants.ts` docblock carries the five-step checklist.
- **Shadow tables.** Creating a `vec0` virtual table also materialises 4–5 companion tables (`<name>_chunks`, `<name>_rowids`, `<name>_vector_chunks00`, `<name>_info`). The unit test in `packages/db/__tests__/unit/client.test.ts` filters them via `substr(name, 1, 18) <> 'context_packs_vec_'` so assertions target the 10-object logical schema.
- **Migration lock.** The `CREATE VIRTUAL TABLE` block is hand-written and sha256-locked via `packages/db/migrations.lock.json`. Drizzle-Kit regenerating `0001` would wipe it; CI and the `.githooks/pre-commit` hook run `pnpm --filter @coodra/db check:migration-lock` to catch that drift before it reaches main.
- **ANN vs brute-force.** `vec0` is an O(n·d) scan engine in 0.1.x; HNSW/IVF support is not in 0.1.9. Solo-mode SQLite search is therefore brute-force, which is acceptable for the dataset sizes solo workflows produce. Team mode uses the Postgres HNSW index.
- **Loadable-extension privilege.** `loadExtension(path)` requires SQLite to have extension loading enabled. `better-sqlite3` enables it for the lifetime of the connection it's called on; no pragma needed.

**Incompatibilities**

- Some GUI tools (TablePlus, DB Browser) cannot introspect `vec0` virtual tables and will surface errors when browsing `context_packs_vec`. Use the CLI (`sqlite3`) for direct inspection.

***

### PostgreSQL (Supabase Postgres)

**Version:** Supabase-managed Postgres; the architecture assumes pgvector ≥ 0.7.0 for HNSW support. [github](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/ai/vector-indexes/hnsw-indexes.mdx)
**Install (local dev):**

- Docker example (must adapt to your environment):  

  ```bash
  docker run --name coodra-pg -e POSTGRES_PASSWORD=secret -p 5432:5432 -d postgres:16
  ```

**Docs:**  
- Postgres: <https://www.postgresql.org/docs/>  
- Supabase Postgres: <https://supabase.com/docs/guides/database>  

#### HNSW index for pgvector

Architecture uses HNSW for `context_packs.summary_embedding` with cosine distance: [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

```sql
CREATE INDEX context_packs_embedding_hnsw ON context_packs
  USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

- Operator classes `vector_l2_ops`, `vector_ip_ops`, `vector_cosine_ops` must match your query operators; for cosine search `<=>` you must use `vector_cosine_ops`. [crunchydata](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- For 3072‑dim embeddings, Supabase suggests using `halfvec` + HNSW as shown: [supabase](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes)

  ```sql
  CREATE TABLE documents (
    id       bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    content  text,
    embedding vector(3072)
  );

  CREATE INDEX ON documents
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
  ``` [supabase](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes)

**Gotchas & caveats**

- HNSW index build time and memory grow with dataset size; Supabase docs recommend upgrading pgvector and using `halfvec` for >2000 dims. [github](https://github.com/orgs/supabase/discussions/21379)
- If you build indexes **without** `CONCURRENTLY`, writes to the table are blocked for the duration of index creation; architecture explicitly calls out using `CONCURRENTLY` in migrations to avoid locks. [github](https://github.com/orgs/supabase/discussions/21379)
- Query plans may still fall back to sequential scan if planner estimates low selectivity; you may need to tune `ANALYZE` and cost parameters.  

**Incompatibilities**

- HNSW is only available in pgvector ≥ 0.7.0; older Supabase projects must upgrade extensions before using the `USING hnsw` syntax. [github](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/ai/vector-indexes/hnsw-indexes.mdx)

***

### pgvector

**Version:** Not pinned; Supabase examples assume recent versions with HNSW support (≥ 0.7.0). [crunchydata](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
**Install (Self‑hosted Postgres):**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Docs:** <https://supabase.com/docs/guides/ai> (pgvector section) [supabase](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes)

#### Operators & HNSW indexes

Supabase docs describe three distance operators and associated operator classes: [github](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/ai/vector-indexes/hnsw-indexes.mdx)

| Operator | Description              | Operator class        |
|---------|--------------------------|-----------------------|
| `<->`   | Euclidean distance       | `vector_l2_ops`       |
| `<#>`   | Negative inner product   | `vector_ip_ops`       |
| `<=>`   | Cosine distance          | `vector_cosine_ops`   | [github](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/ai/vector-indexes/hnsw-indexes.mdx)

Example HNSW index creation: [supabase](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes)

```sql
-- cosine distance
CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);
```

**Gotchas & caveats**

- Index search type must match your query operator; e.g., an index on `vector_cosine_ops` is only used for `<=>` queries. [crunchydata](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- There are maximum supported dimensions per type (vector, halfvec, bit) and version; Supabase docs list 2000 / 4000 / 64000 for pgvector ≥ 0.7.0. [github](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/ai/vector-indexes/hnsw-indexes.mdx)

***

### better-sqlite3

**Version:** 12.9.0 (pinned 2026-04-22 in the Module-01 Foundation commit that introduced `packages/db`; requires Node ≥ 20). [npmjs](https://www.npmjs.com/package/better-sqlite3)
**Install:**

```bash
npm install better-sqlite3
```

**Docs:** <https://github.com/WiseLibs/better-sqlite3> [dev](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8)

#### Synchronous SQLite access for Drizzle

Example usage consistent with architecture’s `createDb()` factory for solo mode: [github](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sqlite-core/README.md)

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const sqlite = new Database(process.env.COODRA_DB_PATH || '~/.coodra/data.db');
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite);
```

- Constructor signature: `new Database(filename, options?)` where `filename` can be a path or `':memory:'` and `options` can include `readonly`, `fileMustExist`, `timeout`, etc. [w3resource](https://www.w3resource.com/sqlite/snippets/better-sqlite3-library.php)
- Drizzle’s SQLite connector expects a `better-sqlite3` instance; example from docs is identical in structure. [orm.drizzle](https://orm.drizzle.team/docs/get-started-sqlite)

**Gotchas & caveats**

- API is synchronous; long-running operations block the Node event loop. Architecture relies on low write volume per design (1–10 devs) so this is acceptable. [dev](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8)
- Requires a C++ toolchain if prebuilt binaries are unavailable for your platform; install failures often trace to missing build tools. [dev](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8)

**Incompatibilities**

- Node.js version < 14.21.1 is not officially supported; you must run on a modern LTS (Node 18/20+). [dev](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8)

***

### Postgres.js (`postgres`)

**Package:** `postgres` (commonly referred to as Postgres.js)  
**Version:** 3.4.9 (pinned 2026-04-22 in the Module-01 Foundation commit that introduced `packages/db`).  
**Install:**

```bash
npm install postgres
```

**Docs:** <https://github.com/porsager/postgres> [github](https://github.com/porsager/postgres)

#### Connection configuration for Supabase + Drizzle

Postgres.js provides a tagged template client: [github](https://github.com/porsager/postgres)

```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const sql = postgres(process.env.DATABASE_URL!, {
  max: 5,
  idle_timeout: 0,
  connect_timeout: 30,
  prepare: false,          // required for some poolers like Supavisor
});

export const db = drizzle(sql);
```

Key options (from docs): [github](https://github.com/porsager/postgres)

```ts
postgres('postgres://user:pass@host:5432/db', {
  host: 'host',
  port: 5432,
  database: 'db',
  username: 'user',
  password: 'pass',
  max: 10,
  idle_timeout: 0,
  connect_timeout: 30,
  ssl: false,
  prepare: true,
  // transform hooks, debug, etc.
});
```

**Gotchas & caveats**

- When used behind Supabase’s Supavisor transaction pooler, you often must set `prepare: false` to avoid prepared-statement issues; the architecture explicitly does this. [github](https://github.com/porsager/postgres)
- With `prepare: true`, Postgres.js automatically creates prepared statements which can exhaust `max_prepared_transactions` on some managed Postgres setups. [github](https://github.com/porsager/postgres)

**Incompatibilities**

- Logical replication and `sql.subscribe` features rely on server configuration that allows replication and logical decoding; not all managed providers expose this. [news.ycombinator](https://news.ycombinator.com/item?id=30794332)

***

### Drizzle ORM & drizzle-kit

**Version:** `drizzle-orm@0.45.2` + `drizzle-kit@0.31.10` (pinned 2026-04-22 in the Module-01 Foundation commit that introduced `packages/db`).  
**Install (SQLite + Postgres):**

```bash
# SQLite (solo mode)
npm install drizzle-orm better-sqlite3
npm install -D drizzle-kit

# Postgres.js (team mode)
npm install drizzle-orm postgres
npm install -D drizzle-kit
```

**Docs:** <https://orm.drizzle.team> (SQLite and Postgres guides) [dev](https://dev.to/burakboduroglu/drizzle-orm-crash-course-3o67)

#### Schema and driver configuration

SQLite (solo mode): [github](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/sqlite-core/README.md)

```ts
// schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  createdAt: integer('created_at').notNull(),
});

// db.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const sqlite = new Database('~/.coodra/data.db');
export const db = drizzle(sqlite);
```

Postgres (team mode): [techboostblog](https://techboostblog.com/blog/drizzle-orm-practical/)

```ts
// drizzle.config.ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

**Gotchas & caveats**

- You must use the correct dialect module (`sqlite-core` vs `pg-core`) and corresponding driver (`drizzle-orm/better-sqlite3` vs `drizzle-orm/postgres-js`). [techboostblog](https://techboostblog.com/blog/drizzle-orm-practical/)
- drizzle-kit migrations are generated from TS schema; destructive changes (column drops) must be rolled out carefully, which architecture already encodes (never drop and remove usage in the same deploy). [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

**Incompatibilities**

- Mixing `pg` and `postgres` drivers in the same project requires separate Drizzle configurations; examples in docs show one driver per config. [techboostblog](https://techboostblog.com/blog/drizzle-orm-practical/)

#### `createDb` local-vs-cloud routing (Module 03 S4)

`packages/db/src/client.ts::createDb` takes a discriminated `kind: 'local' | 'cloud'` option.

- `kind: 'local'` always returns a SQLite handle (regardless of `mode`). Used by every local service — `apps/mcp-server`, `apps/hooks-bridge`, `apps/web` — in BOTH solo and team mode. Matches the architectural rule from `system-architecture.md` §1: "local services always write to local SQLite."
- `kind: 'cloud'` always returns a Postgres handle. Used by future cloud-side processes (Sync Daemon, cloud-api). Local code never picks this branch.
- `mode` is preserved as an auth-strategy hint that flows through to the auth chain. It does NOT change DB choice.
- Module 02 introduced a `COODRA_DB_OVERRIDE_MODE` env var as a stop-gap so a developer could exercise the team-mode auth chain locally without spinning up Postgres. Module 03 S4 makes the override unnecessary by separating `kind` from `mode`. The env knob is removed; existing callers passed it implicitly via `COODRA_MODE=team` and the new contract handles that case natively.

#### `kill_switches` polymorphic-scope pattern + soft-resume (Module 08b S1)

Migration `0007_*` (commit landed 2026-05-03 on `feat/08b-cli-expansion`) adds the `kill_switches` table on both dialects. The shape is the load-bearing schema for the M08b operator-pause/resume surface AND the bridge's pre-policy short-circuit at PreToolUse.

```ts
// packages/db/src/schema/sqlite.ts (postgres mirrors with timestamp(withTimezone))
export const killSwitches = sqliteTable(
  'kill_switches',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),                  // 'global' | 'project' | 'tool' | 'agent_type'
    target: text('target'),                           // null when scope='global'
    mode: text('mode').notNull().default('hard'),    // 'hard' (deny) | 'soft' (allow + audit)
    reason: text('reason').notNull(),
    pausedAt: integer('paused_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    pausedBySessionId: text('paused_by_session_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),  // null = never
    resumedAt: integer('resumed_at', { mode: 'timestamp' }), // null = active
    resumedBySessionId: text('resumed_by_session_id'),
  },
  (t) => [index('kill_switches_active_idx').on(t.resumedAt, t.scope, t.target)],
);
```

Two patterns this table demonstrates that recur elsewhere in the schema:

1. **Polymorphic `(scope, target)`.** Adding a fifth scope value (e.g., `org`, `repo`) is a one-line CHECK update — not a column-addition migration. The bridge's match query in `listActiveKillSwitches` is `WHERE scope IN ('global','tool','agent_type') OR (scope='project' AND target=?)` — project-scoped rows for unrelated projects stay out of the result set. The `findKillSwitchMatchingEvent` pure function then narrows in-memory by `(toolName, agentType)`.

2. **Soft-resume / append-only audit.** `resumed_at IS NULL` is the canonical "active" predicate. Resume sets `resumed_at` + `resumed_by_session_id` — the row stays in the table as audit history, parallels ADR-007's append-only spirit for `decisions` and `context_packs`. The `kill_switches_active_idx` on `(resumed_at, scope, target)` partitions active vs history at the leading column so the bridge's hot-path query touches only the active set.

**Bridge-side cache TTL: 5 seconds.** Much shorter than the 60s policy cache because pause/resume should feel instantaneous to the operator. Local DB read is ~1ms; the cache is a one-line Map with a clock-driven invalidation. Implemented in M08b S2 (`apps/hooks-bridge/src/lib/kill-switch-evaluator.ts`).

**Local-only in M08b** (per OQ-8 lock 2026-05-03). The `sync_to_cloud` queue is NOT enqueued for `kill_switches` writes; cross-developer sync is M04's surface. Document this for any future "why doesn't dev B see dev A's pause?" question.

***

## Queues, Workers & Redis

### BullMQ

**Version:** Not pinned; latest version must be retrieved via `npm view bullmq version`.  
**Install:**

```bash
npm install bullmq
```

**Docs:** <https://docs.bullmq.io> [docs.bullmq](https://docs.bullmq.io/guide/workers)

#### Queue & Worker usage (team mode)

Queue creation and job add (Upstash or other Redis): [aashman.hashnode](https://aashman.hashnode.dev/bullmq-queues-and-workers)

```ts
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_URL!);

export const recordRunEventQueue = new Queue('record-run-event', {
  connection,
});
```

Worker consuming jobs (processor signature as in architecture): [docs.bullmq](https://docs.bullmq.io/readme-1)

```ts
import { Worker, Job } from 'bullmq';

const worker = new Worker(
  'record-run-event',
  async (job: Job) => {
    // job.name: e.g. 'record-run-event'
    // job.data: payload as JSON
    await job.updateProgress(42);
    // persist to Postgres here using Drizzle
  },
  {
    connection,
    concurrency: 10,
  },
);
```

`QueueEvents` for observability: [dev](https://dev.to/axiom_agent/nodejs-job-queues-in-production-bullmq-bull-and-worker-threads-3c35)

```ts
import { QueueEvents } from 'bullmq';

const queueEvents = new QueueEvents('record-run-event', { connection });

queueEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`${jobId} completed`, returnvalue);
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`${jobId} failed: ${failedReason}`);
});
```

**Gotchas & caveats**

- BullMQ requires Redis with streams support; Upstash has been rolling out streams and BullMQ has removed earlier strict host checks to better support Upstash. [github](https://github.com/taskforcesh/bullmq/commit/2e06bca3615aafecd725d093045a510a67053fed)
- For high availability or Sentinel setups, you must pass a fully configured `ioredis` instance with Sentinel configuration; examples show `sentinels` array, `name`, and custom retry strategies. [oneuptime](https://oneuptime.com/blog/post/2026-01-21-bullmq-connection-options/view)
- When using serverless Redis with high latency, job throughput will be limited by round-trip time; architecture’s low throughput target (0.5 req/s) keeps this acceptable. [upstash](https://upstash.com/docs/redis/integrations/bullmq)

**Incompatibilities**

- Redis cluster modes, Sentinel, or TLS require explicit configuration in the connection object; simple host/port/password options are insufficient in those topologies. [community.fly](https://community.fly.io/t/i-am-facing-issue-while-connecting-upstash-redis-instance-with-bullmq/18095)

***

### Upstash Redis

**Version:** Managed service; you do not install it in code.  
**Install (client-side):**

- Typical Upstash + BullMQ connection: [upstash](https://upstash.com/docs/redis/integrations/bullmq)

  ```ts
  import { Queue } from 'bullmq';

  const myQueue = new Queue('foo', {
    connection: {
      host: 'UPSTASH_REDIS_ENDPOINT',
      port: 6379,
      password: 'UPSTASH_REDIS_PASSWORD',
      tls: {},
    },
  });
  ```

**Docs:** <https://upstash.com/docs/redis> (BullMQ integration page) [upstash](https://upstash.com/docs/redis/integrations/bullmq)

#### Connection shape

Configuration object for BullMQ: [upstash](https://upstash.com/docs/redis/integrations/bullmq)

```ts
{
  host: string;      // Upstash endpoint hostname
  port: number;      // typically 6379 for TLS
  password: string;  // Upstash REST/Redis password
  tls: object;       // {} enables TLS, required by Upstash
}
```

**Gotchas & caveats**

- Upstash Redis is serverless with per-request pricing and may have cold start latency; architecture’s reliance on small, infrequent jobs mitigates this. [upstash](https://upstash.com/docs/redis/integrations/bullmq)
- Ensure you use `rediss://` URLs or `tls: {}` when using ioredis directly; some BullMQ versions used host inspection to treat Upstash specially, but that logic has been relaxed. [github](https://github.com/taskforcesh/bullmq/commit/2e06bca3615aafecd725d093045a510a67053fed)

**Incompatibilities**

- Upstash imposes specific limits (connections, throughput) per plan; high‑volume queue usage would require checking those quotas.  

***

### In-process SQLite queue (solo mode)

This is internal, but its shape matters for interoperability with BullMQ processors. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

```sql
CREATE TABLE IF NOT EXISTS pending_jobs (
  id          TEXT PRIMARY KEY,
  queue       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  attempts    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  run_after   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX pending_jobs_poll_idx
  ON pending_jobs (queue, status, run_after);
```

Processor loop (conceptual):

```ts
async function pollJobs() {
  const jobs = db
    .select()
    .from(pendingJobs)
    .where(eq(status, 'pending'))
    .orderBy(asc(runAfter))
    .limit(10);

  // same processor signature as BullMQ:
  // async (job: { id, name: queue, data: payload })
}
```

**Gotchas**

- You must enforce the same job payload shape as BullMQ (`name`, `data`) so that worker functions can be shared between solo and team modes. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

***

## Web Frameworks & HTTP Layer

### Express

**Version:** Architecture lists “Express + MCP SDK” for the MCP Server. The Express website indicates 5.x is the current major line; installing `express@latest` pulls the latest stable (5.x as of late 2024), but you must verify at install time. [stackoverflow](https://stackoverflow.com/questions/46727643/upgrade-to-latest-version-of-express)
**Install:**

```bash
npm install express@latest
```

**Docs:** <https://expressjs.com> [expressjs](https://expressjs.com)

#### Basic server for MCP HTTP endpoint

Minimal structure (adapt to MCP JSON‑RPC handler): [youtube](https://www.youtube.com/watch?v=-MMjFX5UfN4)

```ts
import express from 'express';

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  // handle JSON-RPC 2.0 request
  // req.body: { jsonrpc, method, params, id }
  res.json({ jsonrpc: '2.0', result: {}, id: req.body.id });
});

app.listen(3100, () => {
  console.log('MCP HTTP server listening on :3100');
});
```

**Gotchas & caveats**

- Express 5 introduces subtle changes vs 4 (e.g., router behavior, async error handling); the official 5.0 migration guide should be consulted if upgrading from 4.x. [youtube](https://www.youtube.com/watch?v=-MMjFX5UfN4)
- JSON‑RPC 2.0 handling must ensure no extra bytes are written before/after JSON responses; mixing consolelogging to stdout on the same process that handles MCP stdio is forbidden. [jsonrpc](https://www.jsonrpc.org/specification)

***

### Hono + `@hono/node-server`

**Version:** `hono` npm latest (verify via `npm view hono version`); `@hono/node-server` latest 1.19.3 as of recent docs. [npmjs](https://www.npmjs.com/package/hono)
**Install:**

```bash
npm install hono @hono/node-server
```

**Docs:**  
- Hono: <https://hono.dev>  
- Node adapter: <https://www.npmjs.com/package/@hono/node-server> [npmjs](https://www.npmjs.com/package/@hono/node-server)

#### Hooks Bridge (Hono)

Basic pattern (architecture’s Hooks Bridge on port 3101): [dev](https://dev.to/vuelancer/creating-a-hono-nodejs-api-a-step-by-step-guide-97j)

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

app.get('/v1/health', (c) => c.json({ status: 'ok' }));

app.post('/v1/hooks/pre-tool-use', async (c) => {
  const body = await c.req.json();
  // normalize to HookEvent and evaluate policy
  return c.json({ decision: 'allow' });
});

serve({ fetch: app.fetch, port: 3101 }, (info) => {
  console.log(`Hooks Bridge listening on http://localhost:${info.port}`);
});
```

- Node adapter supports Node ≥ 18.14.1 and uses standard `fetch`-style Request/Response APIs. [npmjs](https://www.npmjs.com/package/@hono/node-server)

**Gotchas**

- Ensure Node version meets adapter requirements (≥ 18.14.1, 19.7.0, or any 20.x+). [npmjs](https://www.npmjs.com/package/@hono/node-server)
- `serve()` default port is 3000; you must pass `port: 3101` to match architecture. [npmjs](https://www.npmjs.com/package/@hono/node-server)

***

### Next.js (Web App)

**Version:** Architecture refers to “Next.js 15”; this may diverge from the currently stable Next.js major version at the time you implement. You must check the official Next.js release notes and migration guides for the exact major and minor version you intend to use. This is a **non‑trivial assumption** in the architecture that must be validated manually. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

**Install (app router + TypeScript example):**

```bash
npx create-next-app@latest coodra-web
```

**Docs:** <https://nextjs.org/docs>

**Features referenced**

- App Router (server-side route handlers, server actions) for proxying browser requests to local services. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)
- SSE endpoint for `/api/runs/[id]/events` (see SSE section).  

Because official Next.js 15 docs weren’t retrieved in this research, all version-specific behaviors (React version, app router API details, streaming semantics) must be verified against the official Next.js documentation at implementation time.  

***

### FastAPI (Python)

**Version:** Not pinned; docs site refers generically to FastAPI (latest stable). Use `pip install "fastapi[standard]"` or similar to get current stable 0.x; verify exact version via `pip show fastapi`. [en.wikipedia](https://en.wikipedia.org/wiki/FastAPI)
**Install:**

```bash
pip install "fastapi[standard]"
```

**Docs:** <https://fastapi.tiangolo.com> [fastapi.tiangolo](https://fastapi.tiangolo.com)

#### Semantic Diff & NL Assembly services

Basic FastAPI pattern consistent with architecture’s semantic diff and NL assembly services: [en.wikipedia](https://en.wikipedia.org/wiki/FastAPI)

```py
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class DiffRequest(BaseModel):
    before: str
    after: str

class DiffResponse(BaseModel):
    summary: str

@app.post("/analyze", response_model=DiffResponse)
async def analyze_diff(req: DiffRequest):
    # AST-based analysis here
    return DiffResponse(summary="TODO")
```

- FastAPI uses Pydantic models for request/response validation and automatically generates OpenAPI + Swagger UI documentation. [fastapi.tiangolo](https://fastapi.tiangolo.com)

**Gotchas**

- Default Uvicorn workers are single process; if you deploy the service behind a load balancer, configure multiple workers (e.g., via `gunicorn -k uvicorn.workers.UvicornWorker`) or the platform’s process model.  
- For CPU‑bound AST work, you may need to ensure concurrency is appropriate; architecture suggests scaling semantic diff horizontally when needed. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

***

## Protocols & Transports

### Model Context Protocol (MCP) & Streamable HTTP

**Docs:** <https://modelcontextprotocol.io/specification/2025-03-26> [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)

#### JSON-RPC 2.0 messages

MCP uses JSON‑RPC 2.0 as its wire format between hosts, clients, and servers. [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26)

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/list",
  "params": {}
}
```

#### Streamable HTTP transport

From the March 2025 transport spec: [brightdata](https://brightdata.com/blog/ai/sse-vs-streamable-http)

- Client sends JSON‑RPC messages via HTTP POST to the MCP endpoint.  
- `Accept` header must include both `application/json` and `text/event-stream`:

  ```http
  POST /mcp HTTP/1.1
  Accept: application/json, text/event-stream
  Content-Type: application/json
  ```

- The body MAY contain a single request or a batch (JSON array of request objects).  
- If any requests are present, the server MUST respond either with:
  - `Content-Type: text/event-stream` (SSE stream of JSON‑RPC messages), or  
  - `Content-Type: application/json` (single JSON object). [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)

The architecture’s MCP server implements both stdio and HTTP transports simultaneously; only agent processes use Streamable HTTP endpoints. [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26)

**Gotchas**

- The MCP Streamable HTTP transport is **not** browser SSE; do not reuse browser `EventSource` semantics (auto reconnect, origin limits) for MCP clients. [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- The server may send requests and notifications back to the client over the same stream; clients must handle this full‑duplex message pattern. [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26)

***

### `@modelcontextprotocol/sdk` (Node.js server)

**Version:** `1.29.0` — pinned **exact** in `apps/mcp-server/package.json` (no caret). MCP is an active protocol; a minor-version bump can add required fields to tool-list entries and we want the ref implementation and our code to move together on a deliberate schedule, not auto-update.
**Install:**

```bash
pnpm --filter @coodra/mcp-server add @modelcontextprotocol/sdk@1.29.0 --save-exact
```

**Docs:** <https://github.com/modelcontextprotocol/typescript-sdk> · <https://modelcontextprotocol.io/specification/2025-03-26>

#### Server vs McpServer — we use the low-level `Server`

The SDK exposes two Node server APIs:

- **`McpServer`** (`@modelcontextprotocol/sdk/server/mcp.js`) — high-level, prescriptive. `McpServer.registerTool(name, { inputSchema, handler })` takes Zod *raw shapes*, validates inputs for you, and formats outputs.
- **`Server`** (`@modelcontextprotocol/sdk/server/index.js`) — low-level. You register request handlers against the SDK's exported Zod schemas (`ListToolsRequestSchema`, `CallToolRequestSchema`) and own every byte of the response.

Coodra's `ToolRegistry` (`apps/mcp-server/src/framework/tool-registry.ts`) already owns input parsing, output validation, the idempotency-key contract, and the automatic policy wrapper. Routing calls through `McpServer.registerTool` would either duplicate that work or invalidate our single-source-of-truth claim. We therefore use `Server` + `setRequestHandler` directly. The SDK marks `Server` as `@deprecated` in favour of `McpServer`, but in context that annotation means "use `McpServer` unless you have a reason to take over the request lifecycle" — and our custom registry is exactly that reason.

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name, version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.list() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  return registry.handleCall(name, args ?? {}, sessionId);
});
await server.connect(new StdioServerTransport());
```

#### Zod v4 compatibility

`@modelcontextprotocol/sdk@1.29.0` supports Zod v4. Our workspace uses Zod v4 uniformly (both `@coodra/shared` and `@coodra/mcp-server`), which lets us drop the third-party `zod-to-json-schema` helper in favour of Zod v4's built-in `z.toJSONSchema(schema, { target: 'draft-2020-12' })` — see `apps/mcp-server/src/framework/manifest-from-zod.ts`.

#### Stdio transport + logger contract (load-bearing)

The stdio transport uses **stdout** exclusively for JSON-RPC frames. A single stray byte on stdout — a `console.log` from our code, a pino line from any transitive dependency — corrupts the transport. The Coodra mcp-server enforces this invariant in three places:

1. `apps/mcp-server/src/bootstrap/ensure-stderr-logging.ts` — side-effect module imported **first** in `src/index.ts`. Sets `COODRA_LOG_DESTINATION=stderr` before `@coodra/shared`'s logger module evaluates.
2. `packages/shared/src/logger.ts` — reads `COODRA_LOG_DESTINATION` at module load; `'stderr'` routes pino to fd 2 via `pino.destination({ fd: 2, sync: true })`. Unknown values throw at boot rather than silently defaulting.
3. `apps/mcp-server/__tests__/unit/transports/stdio-stdout-purity.test.ts` — spawns the real entrypoint, sends an `initialize` frame, and asserts every byte on stdout is a valid JSON-RPC frame and every line on stderr is a parseable pino JSON object.

The Dockerfile and `.mcp.json` both set `COODRA_LOG_DESTINATION=stderr` as a defence-in-depth: even if the bootstrap module were accidentally removed, the env would still be correct.

**Gotchas**

- Do **not** use `console.log` anywhere in `apps/mcp-server/src/` — raw `console.log` writes to stdout regardless of our logger wiring. Biome's `suspicious/noConsole` rule (configured in `biome.json`) catches it at lint time. `console.error` / `console.warn` go to stderr and are safe.
- The SDK's `setRequestHandler` return-type union includes a "task" branch we don't produce; narrow the return with `as unknown as CallToolResult` at the transport boundary (kept to that one file only).
- Tool names are validated against `^[a-z][a-z0-9_]{2,63}$` — hyphens, uppercase letters, and leading digits are rejected by the `ToolRegistry` at registration time.

***

### JSON-RPC 2.0

**Docs:** <https://www.jsonrpc.org/specification> [jsonrpc](https://www.jsonrpc.org/specification)

#### Request & batch format

A request object: [jsonrpc](https://www.jsonrpc.org/specification)

```json
{
  "jsonrpc": "2.0",
  "method": "methodName",
  "params": { "foo": "bar" },
  "id": 1
}
```

Batch requests (array of request objects, as used by MCP Streamable HTTP): [json-rpc](https://www.json-rpc.dev/learn/examples/batch-requests)

```json
[
  { "jsonrpc": "2.0", "method": "getUser",  "params": { "id": 1 }, "id": 1 },
  { "jsonrpc": "2.0", "method": "getOrders", "params": { "userId": 1 }, "id": 2 }
]
```

Responses are arrays of response objects; notifications (no `id`) produce no response. [json-rpc](https://json-rpc.dev/learn/examples/batch-requests)

**Gotchas**

- Order of responses in a batch is **not guaranteed** to match order of requests; correlate using `id` only. [docs.actian](https://docs.actian.com/openroad/6.2/ServerRef/JSON-RPC_Batch_Requests.htm)
- Errors are per‑request; a single failed request in a batch does not prevent other responses. [docs.actian](https://docs.actian.com/openroad/6.2/ServerRef/JSON-RPC_Batch_Requests.htm)

***

### Server-Sent Events (SSE) & EventSource

**Docs:**  
- MDN SSE guide: <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events> [developer.mozilla](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- `EventSource` API: <https://developer.mozilla.org/en-US/docs/Web/API/EventSource> [developer.mozilla](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)

#### Browser → server connection behavior

- Browsers typically limit ~6 concurrent HTTP connections per origin; this applies to SSE connections as well. [stackoverflow](https://stackoverflow.com/questions/59163596/is-there-still-a-practical-6-connection-limit-when-using-server-sent-events-with)
- With HTTP/2, multiple SSE streams can share a single TCP connection, but browser-implemented per‑origin connection limits still apply. [developer.mozilla](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

Basic SSE endpoint for run events:

```ts
// Next.js or Hono-like handler
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(
          new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`),
        );
      };
      // emit initial event, then hook into run-events queue
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

**Gotchas**

- Browsers automatically reconnect on network errors; you must handle `Last-Event-ID` if you care about at‑least‑once delivery semantics.  
- Architecture opens one SSE connection per run detail page, which is safe against the ~6 connection per origin guideline; if you add more SSE streams, consider multiplexing. [developer.mozilla](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)

***

### HTTP/1.1 and HTTP/2

- Solo mode uses HTTP/1.1; tool call rate is low and multiplexing benefits are negligible. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)
- Team cloud mode uses HTTP/2 where supported by Railway/Fly.io TLS terminators; header compression and connection multiplexing are automatic with no app‑level changes. [fly](https://fly.io/docker)

**Gotchas**

- Some HTTP/2 load balancers buffer streaming responses; verify streaming behavior for SSE and MCP Streamable HTTP endpoints on your chosen platform.  

***

## LLM Providers & Structured Output

### Ollama

**Version:** Architecture assumes structured output support released in Ollama ≥ 0.5 and Python/JS clients updated to support `format` as JSON Schema. [ollama](https://ollama.com/blog/structured-outputs)
**Install (server):**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Python client install:**

```bash
pip install ollama
```

**Docs:**  
- Structured outputs blog: <https://ollama.com/blog/structured-outputs> [ollama](https://ollama.com/blog/structured-outputs)
- API overview: <https://ollama.apidog.io/overview-875575m0> [ollama.apidog](https://ollama.apidog.io/overview-875575m0)

#### Structured JSON Schema output

The architecture uses Pydantic models and `format=PetList.model_json_schema()` style schemas: [towardsdatascience](https://towardsdatascience.com/structured-llm-output-using-ollama-73422889c7ad/)

```py
from ollama import chat
from pydantic import BaseModel

class Enrichment(BaseModel):
    summary: str
    breaking_changes: list[str]
    key_decisions: list[str]
    risk_level: str | None

ENRICHMENT_SCHEMA = Enrichment.model_json_schema()

response = chat(
    model='llama3.1',
    format=ENRICHMENT_SCHEMA,      # JSON Schema object, not "json"
    options={'temperature': 0.1},
    messages=[
      {
        'role': 'user',
        'content': 'Summarize this diff into JSON',
      }
    ],
)
enrichment = Enrichment.model_validate_json(response.message.content)
```

From Ollama’s structured outputs article: [towardsdatascience](https://towardsdatascience.com/structured-llm-output-using-ollama-73422889c7ad/)

- `format` can be a JSON schema object; the model then attempts to produce output matching the schema.  
- Pydantic models’ `.model_json_schema()` output is directly usable as `format` parameter. [ollama](https://ollama.com/blog/structured-outputs)

**Gotchas**

- `format: "json"` vs schema: `"json"` enables generic JSON mode but does not enforce a specific schema; architecture explicitly prefers schema‑based `format` to align with Zod → JSON Schema definitions. [ollama.apidog](https://ollama.apidog.io/overview-875575m0)
- Temperature should be low (0–0.2) for structured extraction to reduce hallucinations and schema violations. [towardsdatascience](https://towardsdatascience.com/structured-llm-output-using-ollama-73422889c7ad/)

***

### Anthropic Claude (Structured outputs)

**Version:** Architecture references `claude-3-5-haiku-20241022`; you must check Anthropic’s model catalog and adjust to the latest Claude 3.x or 4.x models available. [platform.claude](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
**Docs:** <https://platform.claude.com/docs/en/build-with-claude/structured-outputs> [platform.claude](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

#### `output_config` with JSON Schema

Anthropic’s structured outputs use `output_config` with JSON Schema: [platform.claude](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "Extract the key information from this email ..."
      }
    ],
    "output_config": {
      "format": {
        "type": "json_schema",
        "schema": {
          "type": "object",
          "properties": {
            "name":   { "type": "string" },
            "email":  { "type": "string" },
            "plan_interest": { "type": "string" },
            "demo_requested": { "type": "boolean" }
          },
          "required": ["name", "email", "plan_interest", "demo_requested"]
        }
      }
    }
  }'
```

**Gotchas**

- You must set `anthropic-version` header to a supported date string; architecture uses an older version (`2023-06-01`), which may need updating as Anthropic deprecates older versions. [platform.claude](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- Schema must be valid JSON Schema; Anthropic does not automatically repair invalid schemas.  

***

### Google Gemini (JSON mode & function calling)

**Docs:** <https://ai.google.dev/gemini-api/docs/function-calling>

**Models referenced in this repo:**
- `gemini-1.5-flash` — older JSON mode, used by the enrichment path in §18.
- `gemini-2.5-flash-preview-04-17` — used by the `jira_test/` prototype's agentic tool-dispatch loop (`jira_test/MCP-Jira-Test-App-Build-Plan.md`). Supports first-class function calling with typed `Tool[]` declarations.

**Node SDK used in the prototype:** `@google/generative-ai` ^0.21.0 (`jira_test/MCP-Jira-Test-App-Build-Plan.md:104`).

#### JSON mode with `response_mime_type` (Gemini 1.5 Flash, Python)

StackOverflow examples show using `response_mime_type` for JSON outputs: [github](https://github.com/google-gemini/deprecated-generative-ai-python/issues/515)

```py
import google.generativeai as genai

model = genai.GenerativeModel(
    'gemini-1.5-flash',
    generation_config={"response_mime_type": "application/json"},
)

prompt = 'List 5 office supplies with this schema: { "Title": str, ... }'

response = model.generate_content(prompt)
print(response.text)
```

#### Function calling (Gemini 2.5 Flash Preview, Node — pattern for MCP tool dispatch)

The `jira_test` prototype wires 8 JIRA MCP tools as Gemini function declarations and loops on `FunctionCall` responses until Gemini returns plain text. This is the reference shape for the `jira_*` MCP tools in §22 when they are exposed through a Gemini-backed agent:

```typescript
import { GoogleGenerativeAI, ChatSession, FunctionCall, Tool } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// 1. Declare the tools — one FunctionDeclaration per MCP tool.
const jiraTools: Tool[] = [{
  functionDeclarations: [{
    name: 'searchIssues',
    description: 'Search Jira issues using a JQL query.',
    parameters: {
      type: 'OBJECT',
      properties: {
        jql: { type: 'STRING', description: 'JQL query' },
        maxResults: { type: 'NUMBER' },
      },
      required: ['jql'],
    },
  }, /* ...seven more... */ ],
}];

// 2. Create the model with tools attached.
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-preview-04-17',
  tools: jiraTools,
  systemInstruction: 'You are a Jira assistant agent. Always use tools to fetch fresh data.',
});

// 3. Agentic loop — Gemini returns FunctionCall(s) or text.
async function runAgentTurn(chat: ChatSession, userMessage: string): Promise<string> {
  let response = await chat.sendMessage(userMessage);
  while (true) {
    const parts = response.response.candidates?.[0].content.parts ?? [];
    const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall!);
    if (functionCalls.length === 0) return response.response.text();

    const toolResults = await Promise.all(functionCalls.map(async (fc) => ({
      functionResponse: { name: fc.name, response: { result: await dispatchTool(fc) } },
    })));
    response = await chat.sendMessage(toolResults as any);
  }
}
```

Source: `jira_test/MCP-Jira-Test-App-Build-Plan.md` §7–§8.

**Free-tier limits (from Google AI Studio, verify at use time):** 10 RPM, 250K TPM, 500 RPD. The architecture's JIRA workloads (one agent session ≈ 5–15 tool calls) fit the free tier comfortably at 1–10 devs.

**Gotchas**

- JSON mode for 1.5 Flash accepts schema **in the prompt**, not as a first‑class JSON Schema object; this is weaker than Ollama or Anthropic's schema enforcement. [stackoverflow](https://stackoverflow.com/questions/78495286/how-can-i-get-a-json-structure-response-from-the-google-gemini-pro-vision)
- Some client libraries (e.g., deprecated `google.generativeai`) were archived and replaced; architecture's code snippets using that package must be updated to current SDKs. [github](https://github.com/google-gemini/deprecated-generative-ai-python/issues/515)
- Gemini 2.5 Flash Preview is a **preview** model — model ID (`gemini-2.5-flash-preview-04-17`) and behaviour can change. Pin the exact date-stamped model string and re-verify before release. Upgrade to the stable `gemini-2.5-flash` once it GAs. [ai.google](https://ai.google.dev/gemini-api/docs/models)
- The `Tool[]` type enum values (`'STRING'`, `'NUMBER'`, `'OBJECT'`, `'ARRAY'`) are uppercased strings in the Node SDK but lower-cased in the REST API — use the SDK constants or cast with `as any` as the prototype does.
- Order of parallel tool responses is preserved by the SDK, but the model may reorder logically — always correlate by `FunctionCall.name`, not position.

***

## Auth & Security

### Clerk (JWT authentication and templates)

**Docs:**  
- JWT templates: <https://clerk.com/docs/guides/sessions/jwt-templates> [clerk](https://clerk.com/docs/guides/sessions/jwt-templates)
- JWT template API (backend SDK example): <https://hexdocs.pm/clerk/JWTTemplate.html> [hexdocs](https://hexdocs.pm/clerk/JWTTemplate.html)
- Example JWT SSO usage: <https://clerk.com/blog/how-we-roll-jwt-sso> [clerk](https://clerk.com/blog/how-we-roll-jwt-sso)

#### JWT Templates

Clerk’s JWT templates are JSON objects specifying claims and lifetimes: [zuplo](https://zuplo.com/docs/dev-portal/zudoku/configuration/authentication-clerk)

- Template fields (Dashboard or API):  
  - `name`: template name (used in `getToken({ template })`).  
  - `lifetime`: token lifetime in seconds.  
  - `allowed_clock_skew`: allowed skew in seconds.  
  - `claims`: JSON object describing JWT payload; can use Clerk shortcodes like `{{user.full_name}}`. [clerk](https://clerk.com/docs/guides/sessions/jwt-templates)

Example claims configuration (Zuplo integration): [zuplo](https://zuplo.com/docs/dev-portal/zudoku/configuration/authentication-clerk)

```json
{
  "name": "{{user.full_name}}",
  "email": "{{user.primary_email_address}}",
  "email_verified": "{{user.email_verified}}"
}
```

Architecture uses a JWT template to mint tokens with org/user identifiers for downstream services (e.g., Supabase RLS). [clerk](https://clerk.com/blog/how-we-roll-jwt-sso)

#### Getting JWTs in Next.js / Node

Patterns from docs and community posts: [stackoverflow](https://stackoverflow.com/questions/78912604/getting-jwt-from-clerk-in-my-reactnext-js-app-to-test-api-calls-using-curl)

```ts
import { auth } from '@clerk/nextjs/server';

export async function callBackend() {
  const { getToken } = auth();
  const token = await getToken({ template: 'coodra' });

  const res = await fetch('https://api.example.com', {
    headers: { Authorization: `Bearer ${token}` },
  });
}
```

**Gotchas**

- Architecture’s three-mode middleware (`sk_test_replace_me`, `LOCAL_HOOK_SECRET`, full Clerk JWT) depends on environment; ensure that bypass secrets (`sk_test_replace_me`) never escape dev environments. [clerk](https://clerk.com/docs/guides/sessions/jwt-templates)
- JWT templates are distinct from session tokens; customizing one does not automatically affect the other. [clerk](https://clerk.com/docs/guides/sessions/jwt-templates)

***

## Validation, Schemas & Resilience

### `@coodra/policy` (workspace package — landed Module 03 S3)

**Version:** workspace-internal (no external pin). Lives at `packages/policy/`.
**Role:** the cache-first policy evaluator + audit-write helper, shared by `apps/mcp-server` (via the `check_policy` tool + the registry's pre/post auto-wrap) and `apps/hooks-bridge` (via the pre-tool-use hook handler). Also owns the discriminated `PolicyClient` / `PolicyInput` / `PolicyResult` / `PolicyDenyError` types.

**Why a new package (not `@coodra/shared/policy`):** `@coodra/db` already depends on `@coodra/shared`. Putting policy in shared would force shared to depend on `@coodra/db` (for `DbHandle` + the schema tables policy queries), creating a workspace cycle. A separate package that depends on both `shared` and `db` resolves the cycle cleanly. The original Module 03 plan (spec.md) said "policy lives in shared" — that wording is corrected in S3's commit; it's the only structural deviation.

**Dep set:**

- `@coodra/shared` (logger + `IdempotencyKey` value-shape).
- `@coodra/db` (DbHandle + schema tables for SELECT policies/policy_rules + INSERT policy_decisions).
- `cockatiel@3.2.1` exact (timeout + breaker fuse).
- `drizzle-orm@^0.45.2` (query builder, matches db's pin).
- `picomatch@4.0.2` exact (path-glob matching at cache-load time).

**Subpath exports:** `.` (factories + audit helper) and `./types` (`PolicyClient`, `PolicyInput`, `PolicyResult`, `PolicyDenyError`).

**Auth lives separately** — `packages/shared/src/auth/` (no DB dep, no new package needed). The `@clerk/backend` dep moved to shared in the same commit.

***

### Zod

**Version:** 4.3.6 (pinned 2026-04-22; bumped from 4.1.9 in the Module-01 Foundation commit that introduced `packages/shared`). [npmjs](https://www.npmjs.com/package/zod)
**Install:**

```bash
npm install zod
```

**Docs:** <https://zod.dev> (JSON Schema section: <https://zod.dev/json-schema>) [zod](https://zod.dev/json-schema)

#### Schemas at external boundaries

Architecture uses Zod for validating hook payloads and aligning TS types with runtime validation. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

Basic usage: [npm](https://npm.io/package/zod)

```ts
import { z } from 'zod';

export const HookEventSchema = z.object({
  agentType: z.enum(['claude_code', 'windsurf', 'unknown']),
  eventPhase: z.enum(['pre', 'post', 'session_start', 'session_end']),
  sessionId: z.string(),
  turnId: z.string().optional(),
  toolName: z.string(),
  filePath: z.string().optional(),
  toolInput: z.unknown(),
  cwd: z.string().optional(),
  projectSlug: z.string().optional(),
});

export type HookEvent = z.infer<typeof HookEventSchema>;
```

**Gotchas**

- Architecture emphasizes **fail‑open** behavior: Zod parse failures on external payloads must result in “allow” decisions, not thrown errors. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

***

### zod-to-json-schema

**Version:** 3.25.2. [tessl](https://tessl.io/registry/tessl/npm-zod-to-json-schema)
**Install:**

```bash
npm install zod-to-json-schema
```

**Docs:** <https://www.npmjs.com/package/zod-to-json-schema> [npmjs](https://www.npmjs.com/package/zod-to-json-schema)

#### Converting Zod schemas for Ollama / Claude

Example (aligned with architecture’s LLM enrichment): [npmjs](https://www.npmjs.com/package/zod-to-json-schema)

```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const EnrichmentSchema = z.object({
  summary: z.string(),
  breaking_changes: z.array(z.string()),
  key_decisions: z.array(z.string()),
  risk_level: z.enum(['low', 'medium', 'high']),
});

export const ENRICHMENT_JSON_SCHEMA = zodToJsonSchema(EnrichmentSchema, 'Enrichment');
```

**Gotchas**

- Zod v4 introduces built‑in `.toJSONSchema()`; using both Zod’s native conversion and `zod-to-json-schema` may be redundant and should be rationalized in your implementation. [infoq](https://www.infoq.com/news/2025/08/zod-v4-available/)

***

### cockatiel (circuit breakers & retries)

**Version:** 3.2.1 (pinned **exact**; first installed in `apps/mcp-server/package.json` on 2026-04-23 during Module 02 S7b. Module 03 S3 (2026-04-25) moved the policy module — and with it the cockatiel breaker — to the new `@coodra/policy` workspace package; the dep migrated with the code. mcp-server now pulls cockatiel transitively through `@coodra/policy`. Hooks-bridge does the same — no separate breaker instance lives in the hooks-bridge tree. [npmjs](https://www.npmjs.com/package/cockatiel)
**Install (exact pin):**

```bash
pnpm --filter @coodra/policy add cockatiel@3.2.1 --save-exact
```

**Docs:** <https://www.npmjs.com/package/cockatiel>

#### Circuit breaker policy for DB / LLMs (the policy-engine pattern Coodra actually uses)

Coodra uses the v3.x functional API — `circuitBreaker(handleAll, { halfOpenAfter, breaker })` and `wrap(timeout, circuitBreaker)` for a timeout-then-breaker fuse. This is exactly what `apps/mcp-server/src/lib/policy.ts` builds for the policy-rule DB read path (§7 "Fault Tolerance" + §5 "Policy Evaluation → AP").

```ts
import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleAll,
  timeout,
  TimeoutStrategy,
  wrap,
} from 'cockatiel';

// Verbatim §7 config: open after 5 consecutive failures, probe for
// recovery after 30s. 100ms per-call fuse so a pathological query
// cannot blow the policy-check budget even before the breaker trips.
const policyBreaker = circuitBreaker(handleAll, {
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(5),
});
const policyFuse = timeout(100, TimeoutStrategy.Aggressive);
const policyPolicy = wrap(policyFuse, policyBreaker);

async function evaluateWithBreaker<T>(fn: () => Promise<T>): Promise<T> {
  return policyPolicy.execute(fn);
}
```

**Gotchas**

- Architecture mandates fail-open: when the breaker is open OR the timeout fuse trips, the caller must immediately return `{ decision: 'allow', reason: 'policy_check_unavailable', matchedRuleId: null }` rather than propagate. See `packages/policy/src/policy.ts` for the canonical implementation (moved from `apps/mcp-server/src/lib/policy.ts` in Module 03 S3).
- `wrap(timeout, breaker)` applies the timeout to each attempt; `wrap(breaker, timeout)` would apply it to the whole breaker execution — keep the timeout on the inside.
- `BrokenCircuitError` (thrown when the breaker is open) and `TaskCancelledError` (thrown on timeout) must both be caught at the boundary. Don't differentiate — both map to `allow` with the same reason.
- `TimeoutStrategy.Aggressive` aborts the in-flight operation via `AbortSignal`; your callback must honour the signal argument cockatiel passes through. better-sqlite3 calls are synchronous so the signal is advisory — the breaker still counts them as failures on timeout.

***

### @clerk/backend (JWT verification, Node server)

**Version:** 3.3.0 (pinned **exact**; first installed in `apps/mcp-server/package.json` on 2026-04-23 during Module 02 S7b. Module 03 S3 (2026-04-25) moved the auth module — and with it the dep — to `packages/shared/src/auth/`; the dep migrated with the code. mcp-server and hooks-bridge both pull `@clerk/backend` transitively through `@coodra/shared`. [npmjs](https://www.npmjs.com/package/@clerk/backend)
**Install (exact pin):**

```bash
pnpm --filter @coodra/shared add @clerk/backend@3.3.0 --save-exact
```

**Docs:** <https://clerk.com/docs/references/backend/overview>

#### `verifyToken` — the Coodra JWT verification entrypoint

Module 02 `apps/mcp-server/src/lib/auth.ts` calls `createClerkClient({ secretKey, publishableKey }).verifyToken(token)` to authenticate inbound Bearer JWTs. Per §19 + decisions-log 2026-04-22 Q-02-1 the auth chain is: solo-bypass → `X-Local-Hook-Secret` → full Clerk JWT; the Clerk path is step 3 and is the only one that calls this library.

```ts
import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.CLERK_PUBLISHABLE_KEY,
});

// Returns the verified JWT payload ({ sub, org_id, ... }) or throws
// if the token is malformed / expired / signed by a different tenant.
const payload = await clerk.verifyToken(bearerToken);
const identity = {
  userId: payload.sub,
  orgId: (payload.org_id as string | undefined) ?? null,
  source: 'clerk' as const,
};
```

**Gotchas**

- `verifyToken` fetches JWKS from the Clerk tenant on first use and caches it in-process. First call adds ~150ms; subsequent calls are ~1ms. If you're writing a latency assertion, warm the client in `beforeAll`.
- Pass the **raw token**, not the `Bearer <token>` string. Strip the prefix at the HTTP middleware layer.
- `publishableKey` is required alongside `secretKey` even server-side; omitting it throws at `verifyToken` time with an unhelpful message. The env schema in `apps/mcp-server/src/config/env.ts` already enforces both being present in team mode.
- The solo-bypass sentinel `sk_test_replace_me` is NEVER accepted by this library — it is short-circuited one layer up in `createAuthClient(env)` before any Clerk call is made.
- Module 02 ships this wired but **not live-validated against a real Clerk tenant** — see `context_memory/pending-user-actions.md` (Clerk provisioning, due by Module 04 or first team-mode flip).

***

### picomatch (glob matcher for policy-rule path matching)

**Version:** 4.0.2 (pinned **exact**; first installed in `apps/mcp-server/package.json` on 2026-04-23 during Module 02 S7b. Module 03 S3 (2026-04-25) moved the policy module to `@coodra/policy`; the policy-side picomatch dep moved with it. mcp-server keeps a separate direct dep on picomatch because `tools/get-feature-pack/handler.ts` uses it independently — that's a different consumer, unrelated to the policy-rule path matcher. [npmjs](https://www.npmjs.com/package/picomatch)
**Install (exact pin):**

```bash
pnpm --filter @coodra/policy add picomatch@4.0.2 --save-exact
pnpm --filter @coodra/policy add -D @types/picomatch@4.0.2 --save-exact
# mcp-server keeps its own (separate use site for feature-pack glob filtering):
pnpm --filter @coodra/mcp-server add picomatch@4.0.2 --save-exact
```

**Docs:** <https://github.com/micromatch/picomatch>

#### Policy-rule path matcher

`apps/mcp-server/src/lib/policy.ts` compiles each rule's `match_path_glob` at cache-load time and reuses the compiled matcher across calls — not at every `evaluate()` invocation. This keeps the policy-check path under the §8 solo latency target even when a project has hundreds of active rules.

```ts
import picomatch from 'picomatch';

// Compiled once per rule at cache-load time.
const matchSrcTs = picomatch('src/**/*.ts', {
  // Treat an unset path the same as an unmatched path.
  dot: false,
  // No brace-expansion overhead for the common case; callers that
  // want it set this true explicitly in the rule metadata.
  nobrace: true,
});

matchSrcTs('src/lib/auth.ts');     // true
matchSrcTs('src/lib/auth.test.ts'); // true
matchSrcTs('dist/lib/auth.js');     // false
```

**Gotchas**

- Compiling `picomatch(pattern)` on every evaluate call is expensive enough to matter at ~500 rules — always memoize on cache-load.
- `picomatch(undefined)` throws; rules without a `match_path_glob` must be handled before calling picomatch (the `lib/policy.ts` matcher returns "any path" for rules with a null pattern).
- Matcher returns `false` for empty-string input. Policy callers that receive no `filePath` in `toolInput` should use a sentinel (e.g. `''`) and treat `false` as "rule does not apply".
- Chose over `minimatch`: picomatch is ~10× faster per match, zero dependencies, syntax superset; matches the choice already made by Biome, fast-glob, globby, and chokidar upstream.

***

## Logging

### Pino

**Version:** 10.3.1 (pinned 2026-04-22; bumped from 9.9.5 in the Module-01 Foundation commit that introduced `packages/shared`). **Major bump — Pino 10 is ESM-only.** [npmjs](https://www.npmjs.com/package/pino)
**Install:**

```bash
npm install pino
```

**Docs:** <https://www.npmjs.com/package/pino> [npmjs](https://www.npmjs.com/package/pino)

#### Structured logging with correlation IDs

Basic usage from docs: [dev](https://dev.to/signoz/pino-logger-complete-guide-to-logging-in-nodejs-with-pino-7b)

```ts
import pino from 'pino';

export const logger = pino();

logger.info({ sessionId, runId, orgId }, 'PreToolUse decision allow');
```

- Pino produces newline‑delimited JSON suitable for log aggregation. [npmjs](https://www.npmjs.com/package/pino)

**Gotchas**

- For pretty logs in dev, you can pipe through `pino-pretty`; do **not** use pretty transports in production hot path due to performance cost. [libraries](https://libraries.io/npm/pino-api-logger)
- **Pino 10 is ESM-only.** Consumers must use `import pino from 'pino'` from an ESM context; `require('pino')` is no longer supported. Coodra's `tsconfig.base.json` sets `module: NodeNext`, which matches Pino 10's expectations. Transitive consumers that still ship CJS will need to be updated or pinned.
- **`COODRA_LOG_DESTINATION` env contract** (added 2026-04-23, S5): services that own stdout as a protocol channel — today only `@coodra/mcp-server` under the MCP stdio transport — set this env to `stderr` before any import of `@coodra/shared`. `packages/shared/src/logger.ts` reads it at module load and routes pino to fd 2 via `pino.destination({ fd: 2, sync: true })`. Accepted values: unset / `stdout` / `stderr`; anything else throws at boot. See the `@modelcontextprotocol/sdk` entry under Protocols & Transports for the full enforcement story.

***

## Tooling: Testing, Linting, Monorepo

### TypeScript

**Version:** 6.0.3 (pinned 2026-04-22 in Coodra; previously unspecified in this reference). [npmjs](https://www.npmjs.com/package/typescript)
**Install (repo-local dev dependency — Coodra pattern):**

```bash
pnpm add -Dw typescript@^6.0.3
```

**Docs:** <https://www.typescriptlang.org/docs/>

#### Compiler configuration used by Coodra

The root `tsconfig.base.json` is the source of truth for compiler options; every workspace package extends it. Key options:

```jsonc
// tsconfig.base.json  (excerpt — see the file for full contents)
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

**Gotchas**

- `verbatimModuleSyntax: true` requires explicit `import type` on type-only imports; mixed imports are an error.
- `exactOptionalPropertyTypes: true` makes `{ field?: string }` reject `{ field: undefined }`; use `field?: string` + omission, or switch to `field: string | undefined` if explicit undefined must be allowed.
- ESM-only packages (notably `pino@^10`) require `module: NodeNext` (or equivalent ESM mode). TS 6's `NodeNext` mode is the supported path.
- TS 6 is newer than the vast majority of ecosystem `@types/*` packages; keep `skipLibCheck: true` so third-party types are compiled opportunistically rather than as hard errors.

***

### Vitest

**Version:** 4.1.5 (pinned 2026-04-22; bumped from 4.1.4 in the Module-01 Foundation commit). [npmjs](https://www.npmjs.com/package/vitest)
**Install:**

```bash
npm install -D vitest
```

**Docs:** <https://vitest.dev> [vitest](https://vitest.dev)

#### Usage in CI

Architecture runs `vitest run` in CI stage. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

Typical config snippet:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**Gotchas**

- Vitest integrates with Vite config; keep Vite and Vitest versions compatible (Vitest 4.1 added support for Vite 8). [vitest](https://vitest.dev/blog/vitest-4-1.html)

***

### Biome

**Package:** `@biomejs/biome`  
**Version:** 2.4.12 (pinned 2026-04-22; bumped from 2.2.4 in the Module-01 Foundation commit). [npmjs](https://www.npmjs.com/package/@biomejs/biome)
**Install:**

```bash
npm install --save-dev --save-exact @biomejs/biome
```

**Docs:** <https://biomejs.dev> [biomejs](https://biomejs.dev/linter/)

#### Lint & format in CI

Architecture uses `biome check` as part of its CI pipeline. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

Commands (docs): [dev](https://dev.to/nqhed/biome-a-good-tool-for-linting-and-formatting-code-4g4j)

```bash
# format files
npx @biomejs/biome format --write

# lint files and apply safe fixes
npx @biomejs/biome lint --write

# run all checks locally
npx @biomejs/biome check --write

# CI (no writes)
npx @biomejs/biome ci
```

Config file: `biome.json` or `biome.jsonc` at repo root. [spacejelly](https://spacejelly.dev/posts/lint-format-javascript-with-biome)

**Gotchas**

- Biome differentiates **safe** vs **unsafe** fixes; CI commands will not apply unsafe fixes by default. [biomejs](https://biomejs.dev/linter/)
- Recommended to pin Biome version with `--save-exact` to avoid team drift in formatting. [spacejelly](https://spacejelly.dev/posts/lint-format-javascript-with-biome)

***

### Turborepo (`turbo`)

**Version:** 2.9.6 (pinned 2026-04-22 in Coodra; previously unspecified in this reference). [npmjs](https://www.npmjs.com/package/turbo)
**Install (as a repo-local dev dependency — Coodra pattern):**

```bash
pnpm add -Dw turbo@^2.9.6
```

Global install is also supported but the repo-local dev-dependency pattern keeps the pinned version reproducible across machines and CI.

**Docs:** <https://turbo.build/repo/docs> [nhost](https://nhost.io/blog/how-we-configured-pnpm-and-turborepo-for-our-monorepo)

#### Build pipeline for monorepo

Example from monorepo guide: [turborepo](https://turborepo.dev/docs/guides/publishing-libraries)

```jsonc
// turbo.json  (Turborepo 2.x)
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "build/**"]
    },
    "test": {
      "dependsOn": ["build"]
    }
  }
}
```

> **Gotcha (2.x):** Turborepo 2 renamed the top-level `pipeline` key to `tasks`. Configurations written for 1.x will error. Coodra uses `tasks`.

Architecture’s `turbo build` in CI aligns with this pattern. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

**Gotchas**

- Turborepo is not a package manager; dependency installation is managed by npm/pnpm/yarn. [reddit](https://www.reddit.com/r/nextjs/comments/1bmhy6w/is_this_how_npm_install_works_in_a_turborepo/)

***

## Graphify CLI

**Nature:** External static analysis CLI invoked via Coodra CLI; not part of this repository. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

Architecture usage: [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

```bash
coodra graphify analyze ./my-project

# internally runs:
graphify analyze ./my-project --output /tmp/ctx-graph.json

# then posts graph.json to:
POST /api/graphify/analyze
POST /api/graphify/import
```

Because no official Graphify documentation was retrieved in this research, you must:

- Verify the actual CLI name (`graphify`) and argument syntax (`analyze`, `--output`) against its official docs.  
- Confirm `graph.json` schema (nodes, edges, communities) and whether it is stable across Graphify versions. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

This is explicitly flagged in the architecture as an open decision; schema stability requires manual validation. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

***

## Deployment Platforms

### Railway

**Docs:** <https://railway.com/deploy/nodejs> [dev](https://dev.to/arunangshu_das/how-to-deploy-a-nodejs-app-on-railway-in-under-10-minutes-1fem)

#### Node.js deployment

Railway’s Node.js deployment guide: [railway](https://railway.com/deploy/nodejs)

- Deploy via GitHub integration; each commit triggers build and deploy.  
- Node.js template uses a simple `index.js` and `PORT` environment variable:

  ```js
  const express = require('express');
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  ``` [dev](https://dev.to/arunangshu_das/how-to-deploy-a-nodejs-app-on-railway-in-under-10-minutes-1fem)

**Gotchas**

- Railway expects the app to listen on `process.env.PORT`; using a hardcoded port will break deployments. [railway](https://railway.com/deploy/Abo1zu)

***

### Fly.io

**Docs:**  
- Dockerfile deploy: <https://fly.io/docs/languages-and-frameworks/dockerfile/> [fly](https://fly.io/docs/languages-and-frameworks/dockerfile/)
- `fly deploy` command: <https://fly.io/docs/flyctl/deploy/> [fly](https://fly.io/docs/flyctl/deploy/)

#### Docker deploy

Architecture uses Fly.io (or Railway) for single-region deployments. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)

Basic flow: [fly](https://fly.io/docs/languages-and-frameworks/dockerfile/)

```bash
fly launch          # generates fly.toml and Dockerfile
fly deploy          # builds and deploys Docker image
```

Key options on `fly deploy`: [fly](https://fly.io/docs/flyctl/deploy/)

- `--config`: custom `fly.toml`.  
- `--local-only`: build image locally.  
- `--regions`: limit deploy to specific regions.  
- `--strategy`: `rolling`, `bluegreen`, etc. [fly](https://fly.io/docs/flyctl/deploy/)

**Gotchas**

- `fly deploy --region xxx` affects where machines are deployed but does not automatically remove other regions; locking to a single region may require using volumes or config tweaks. [community.fly](https://community.fly.io/t/fly-deploy-not-limiting-regions/6417)

***

## Atlassian / Jira Integration

This section covers every third-party API, library, and wire format the JIRA integration (system-architecture §22) depends on. A working prototype already exists in `v1/jira_test/` (Python + FastAPI + Streamlit + Gemini) — its build plan at `v1/jira_test/MCP-Jira-Test-App-Build-Plan.md` is the behavioural spec for the Node/TypeScript production implementation.

### Jira Cloud REST API v3

**Base URL (OAuth 2.0):** `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3` (the `cloudId` is returned by `GET https://api.atlassian.com/oauth/token/accessible-resources`).
**Base URL (Basic / API token, solo mode):** `https://<your-domain>.atlassian.net/rest/api/3` (e.g. `https://mcptest01.atlassian.net/rest/api/3`, as used in `v1/jira_test/api/jira_client.py`).
**Docs:** <https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/>

#### Endpoints wrapped by the 8 MCP tools

| MCP tool | HTTP | Path | jira.js method |
|---|---|---|---|
| `jira_search_issues` | `POST` | `/rest/api/3/search/jql` | `client.issueSearch.searchForIssuesUsingJql({ jql, maxResults, fields })` |
| `jira_get_issue` | `GET` | `/rest/api/3/issue/{issueIdOrKey}` | `client.issues.getIssue({ issueIdOrKey })` |
| `jira_create_issue` | `POST` | `/rest/api/3/issue` | `client.issues.createIssue({ fields })` |
| `jira_update_issue` | `PUT` | `/rest/api/3/issue/{issueIdOrKey}` | `client.issues.editIssue({ issueIdOrKey, fields })` |
| `jira_list_transitions` | `GET` | `/rest/api/3/issue/{issueIdOrKey}/transitions` | `client.issues.getTransitions({ issueIdOrKey })` |
| `jira_transition_issue` | `POST` | `/rest/api/3/issue/{issueIdOrKey}/transitions` | `client.issues.doTransition({ issueIdOrKey, transition })` |
| `jira_add_comment` | `POST` | `/rest/api/3/issue/{issueIdOrKey}/comment` | `client.issueComments.addComment({ issueIdOrKey, body })` |
| `jira_list_projects` | `GET` | `/rest/api/3/project/search` | `client.projects.searchProjects({})` |

#### Critical: `/search/jql` (enhanced search), not `/search`

The old `GET /rest/api/3/search` and `POST /rest/api/3/search` endpoints are **deprecated and being removed** per Atlassian changelog `CHANGE-2046`. The production implementation must use `POST /rest/api/3/search/jql`, which is what the `jira_test` prototype already does (`v1/jira_test/api/jira_client.py:44`).

```python
# Correct (prototype): POST /rest/api/3/search/jql
resp = requests.post(
    f"{BASE_URL}/search/jql",
    json={"jql": jql, "maxResults": max_results, "fields": [...]},
    auth=AUTH, headers=HEADERS,
)
```

**Docs:** <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/>

**Gotchas**
- Old Connect apps calling `/search` receive `"The requested API has been removed. Please use the newer, enhanced search-based API instead."` Do not copy pre-2024 examples from Stack Overflow or blog posts without verifying the endpoint path.
- `/search/jql` returns a `nextPageToken` for pagination — the old `startAt`/`total` fields are not returned. If the prototype's code assumes `total`, treat it as unknown-until-paginated.
- `fields` is required — if you omit it, all fields are returned and payloads can exceed 10 MB on issues with many custom fields.

#### Error responses

| HTTP | Meaning | Handling in IntegrationClient |
|---|---|---|
| 400 | Malformed JQL / invalid field | Return `{ error: 'bad_request', retryable: false }` — do not retry |
| 401 | Token invalid or expired | Trigger one refresh + one retry; if still 401, mark `integrations.status='expired'` |
| 403 | Scope missing / user lacks permission | Return `{ error: 'forbidden', retryable: false }` |
| 404 | Issue or project not found | Return `{ ok: true, value: null }` (not an error — absence) |
| 429 | Rate limited | Honour `Retry-After` header; circuit breaker opens on 5 consecutive 429s |
| 5xx | Atlassian outage | Retry twice with exponential backoff; breaker opens |

---

### Atlassian OAuth 2.0 (3LO)

**Docs:** <https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/>

OAuth 2.0 authorization code grant, three-legged. Used by team mode. Solo mode uses Basic auth + API token instead (see below).

#### Authorization URL

```
https://auth.atlassian.com/authorize
  ?audience=api.atlassian.com
  &client_id=<env.ATLASSIAN_CLIENT_ID>
  &scope=<space-separated scopes>
  &redirect_uri=https://app.coodra.dev/api/integrations/atlassian/oauth/callback
  &state=<HMAC-signed CSRF token that encodes orgId + projectSlug + nonce>
  &response_type=code
  &prompt=consent
```

#### Token exchange

```
POST https://auth.atlassian.com/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "client_id": "...",
  "client_secret": "...",
  "code": "<code from callback>",
  "redirect_uri": "https://app.coodra.dev/api/integrations/atlassian/oauth/callback"
}
```

Response:
```json
{
  "access_token": "eyJ...",
  "expires_in": 3600,
  "refresh_token": "eyJ...",
  "scope": "read:jira-work write:jira-work ...",
  "token_type": "Bearer"
}
```

#### Accessible resources (list of sites the token can access)

```
GET https://api.atlassian.com/oauth/token/accessible-resources
Authorization: Bearer <access_token>

[
  {
    "id": "1324a887-45db-1bf4-1e99-ef0ff456d421",    // this is the cloudId
    "url": "https://your-domain.atlassian.net",
    "name": "your-domain",
    "scopes": ["read:jira-work", "..."],
    "avatarUrl": "..."
  }
]
```

Store this `id` as `integrations.cloud_id`. Every subsequent API call uses `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`.

#### Token refresh

```
POST https://auth.atlassian.com/oauth/token
{
  "grant_type": "refresh_token",
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "<old refresh token>"
}
```

Returns a new `access_token` + `refresh_token` pair. The refresh token **rotates** — the old one becomes invalid immediately after exchange. Store the new pair atomically.

#### Scopes required for the 8 MCP tools

```
read:jira-work          ← search, get issue, list projects, list transitions
read:jira-user          ← issue assignee display names
read:me                 ← bot account identity (to skip own comments in webhooks)
write:jira-work         ← create issue, update issue, transition, add comment
manage:jira-webhook     ← register + refresh webhooks
offline_access          ← required to receive a refresh_token
```

**Granular scope docs:** <https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/>

#### Gotchas

- **Implicit grant flow is not supported** — you MUST use authorization code. Source: official 3LO known issues.
- **CORS whitelisting is not supported** for OAuth endpoints — all OAuth calls must come from your server, never from the browser.
- **Scope strings are space-separated in the URL** but comma-separated in some of Atlassian's older docs. The URL form is correct.
- The `state` parameter is mandatory for CSRF protection — Atlassian does not verify it, you must. Sign it with a server-side secret and validate in the callback.
- Access token lifetime is 1 hour; refresh token lifetime is 90 days of inactivity. A user who hasn't used the integration in 90 days must reconnect.
- Multi-site: a single token can access every site the granting user is a member of — store one `integration` row per (orgId, cloudId) pair and disambiguate in the API URL.

---

### Atlassian Webhooks (HMAC verification)

**Docs:** <https://developer.atlassian.com/cloud/jira/platform/webhooks/>

#### Registering a webhook (REST API, for OAuth 2.0 apps)

```
POST https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/webhook
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "url": "https://hooks.coodra.dev/v1/webhooks/atlassian?integration={integrationId}",
  "webhooks": [{
    "events": [
      "jira:issue_created",
      "jira:issue_updated",
      "jira:issue_deleted",
      "comment_created",
      "comment_updated"
    ],
    "jqlFilter": "project in (KAN, PROJ)"
  }]
}
```

Response includes a `webhookRegistrationResult[].createdWebhookId` — store this as `integrations.webhook_id` so you can refresh/delete it later.

**Complete event list:** `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, `worklog_created`, `worklog_updated`, `worklog_deleted`, `comment_created`, `comment_updated`, `comment_deleted`, `attachment_created`, `attachment_deleted`, `issuelink_created`, `issuelink_deleted`, and more — see docs for the full list.

#### HMAC signature verification

When a webhook is configured as a **secure admin webhook** (required for OAuth 2.0 apps), Atlassian sets a shared secret at registration time and signs every payload.

The HMAC is generated using:
- **Secret:** the shared token you provided at webhook registration
- **Payload:** the raw request body (UTF-8)
- **Algorithm:** as listed in the webhook's `method` field (HMAC-SHA256 is standard)

Sent as header:
```
x-hub-signature: sha256=<hex-encoded-hmac>
```

**Verification in Node (team mode Hooks Bridge handler):**
```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyAtlassianWebhook(
  rawBody: Buffer,
  headerSig: string,
  secret: string,
): boolean {
  if (!headerSig?.startsWith('sha256=')) return false;
  const received = Buffer.from(headerSig.slice('sha256='.length), 'hex');
  const computed = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === computed.length && timingSafeEqual(received, computed);
}
```

**Critical:** use `timingSafeEqual` (not `===`). A naive string compare leaks the secret through timing side-channels.

#### Gotchas (from Atlassian community)

- The `x-hub-signature` header is only present on **secure admin webhooks**, not on legacy webhook configurations. If your handler is receiving payloads without a signature, the webhook was created in a non-secure mode — re-register via the REST API.
- Some users report [x-hub-signature validation failing on `issue_updated` but succeeding on `comment_created`](https://community.developer.atlassian.com/t/how-is-x-hub-signature-header-built-for-issue-updated-events/91456) — verify against the raw UTF-8 bytes before any JSON parsing; `JSON.parse` + re-stringify will break the signature.
- Webhook payloads can contain Unicode — handle as UTF-8, never as ASCII.
- Atlassian will retry failed deliveries (non-2xx) with backoff, but drops after a limited number of attempts — your handler must return 200 OK within a short budget even if processing is deferred.

#### Webhook lifecycle — 30-day expiry

Webhooks registered via REST **expire after 30 days**. Refresh them via:

```
PUT https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/webhook/refresh
{
  "webhookIds": [ <integer ids from registration> ]
}
```

Run a daily cron (`sweep-webhook-renewals`) that refreshes any webhook whose `expirationDate` is within 7 days.

#### Concurrency limiting

Atlassian limits concurrent webhook deliveries per app — if your handler is slow, subsequent events queue. Keep the handler fast: verify signature → enqueue job → return 200. Do not process inline.

---

### Atlassian Document Format (ADF)

**Why it exists:** Jira REST API v3 stores rich text as structured JSON, not plain strings. Any field with a `text`-rich value (description, comment body, summary of certain custom fields) MUST be submitted as an ADF document. Submitting a plain string to v3 returns a 400 error.

**Minimal ADF wrapper for plain text:**
```json
{
  "type": "doc",
  "version": 1,
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Your plain text here" }
      ]
    }
  ]
}
```

This exact shape is what the prototype uses in `v1/jira_test/api/jira_client.py:26` (`_make_adf()`) and what the build plan specifies for `createIssue` / `updateIssue` / `addComment`. Use the same helper in the Node implementation.

**Rich formatting nodes:**
- `paragraph`, `heading` (with `attrs: { level: 1-6 }`), `bulletList` / `orderedList` with `listItem`, `codeBlock` (with `attrs: { language }`)
- `mention` (with `attrs: { id, text }` — `id` is the Atlassian accountId, required for at-mentions in comments)
- `inlineCard` (with `attrs: { url }` — renders as a link card pointing to a context pack URL)
- `hardBreak`, `rule` (horizontal divider)

**When rendering ADF back to plain text** (for the agent to read in `jira_get_issue` response), flatten recursively:
```typescript
function adfToPlainText(doc: ADFDoc): string {
  const out: string[] = [];
  const walk = (node: { type: string; text?: string; content?: any[] }) => {
    if (node.type === 'text' && node.text) out.push(node.text);
    if (node.content) node.content.forEach(walk);
    if (node.type === 'paragraph' || node.type === 'heading') out.push('\n');
  };
  doc.content?.forEach(walk);
  return out.join('').trim();
}
```

**Gotchas**

- The `mention` node's `text` attribute is what renders when ADF is shown — but the `id` is what makes the mention actually notify someone. Agents creating comments with `@mentions` must resolve account IDs via `GET /rest/api/3/user/search` first.
- Custom fields of type "Rich text" require ADF; "Text field (multi-line)" and "Text field (single line)" take plain strings. Check field schema before writing.
- ADF must be valid — malformed nodes return a 400 with a cryptic message. When in doubt, produce only the minimal wrapper + `text` nodes.

**Docs & spec:** <https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/> (walk the linked "node types" pages for each shape).

---

### jira.js v4 (MrRefactoring)

**Package:** `jira.js`
**Docs:** <https://github.com/MrRefactoring/jira.js> · <https://mrrefactoring.github.io/jira.js/>
**Install:**
```bash
npm install jira.js
```

**Used by the prototype** (`v1/jira_test/MCP-Jira-Test-App-Build-Plan.md` specifies `^4.0.0` for the Node implementation; the Python prototype uses `requests` directly).

#### Version3Client — matches REST API v3

```typescript
import { Version3Client } from 'jira.js';

// Solo mode / Basic auth
const soloClient = new Version3Client({
  host: 'https://your-domain.atlassian.net',
  authentication: {
    basic: {
      email: process.env.JIRA_EMAIL!,
      apiToken: process.env.JIRA_API_TOKEN!,
    },
  },
});

// Team mode / OAuth 2.0 access token
const teamClient = new Version3Client({
  host: `https://api.atlassian.com/ex/jira/${cloudId}`,
  authentication: {
    oauth2: { accessToken: accessTokenFromDb },
  },
});
```

**All methods are fully typed** and return typed response objects. Examples (full mapping in the table above):

```typescript
// Search
const result = await client.issueSearch.searchForIssuesUsingJql({
  jql: 'project = KAN AND status = "To Do"',
  maxResults: 20,
  fields: ['summary', 'status', 'assignee', 'priority', 'labels', 'issuetype'],
});

// Create (note ADF wrapper on description)
const issue = await client.issues.createIssue({
  fields: {
    project: { key: 'KAN' },
    summary: 'New task',
    issuetype: { name: 'Task' },
    description: { type: 'doc', version: 1, content: [{
      type: 'paragraph', content: [{ type: 'text', text: 'Details here' }],
    }] },
  } as any,   // `as any` because some description shapes aren't in the default typing
});

// Transition (two-step: list then apply)
const transitions = await client.issues.getTransitions({ issueIdOrKey: 'KAN-1' });
const target = transitions.transitions?.find(t => t.name?.toLowerCase() === 'in progress');
if (target?.id) {
  await client.issues.doTransition({
    issueIdOrKey: 'KAN-1',
    transition: { id: target.id },
  });
}
```

#### Authentication modes supported

- `basic` — email + API token (solo mode)
- `oauth2` — bearer access token (team mode; refresh is your responsibility)
- `oauth` (legacy OAuth 1.0a with RSA) — do not use for new integrations

Only the first two are relevant.

#### Tree-shaking

jira.js v4 is structured as many small classes (`client.issues`, `client.issueSearch`, `client.projects`, etc.). Importing only the top-level `Version3Client` still gets most of the bundle because the client wires up every endpoint. This is acceptable on the server; the web app should not bundle jira.js into client JS.

#### Gotchas

- jira.js v4 imports the full typed surface — install breaks on `typescript` versions older than 4.7. Use TS 5.x.
- `doTransition` does not return the updated issue; you must `getIssue` afterwards to confirm the new status.
- The typed response sometimes declares fields as `string | undefined` when they are effectively always present for the Cloud API — unwrapping with `!` or defaulting to `'Unassigned'` (as the prototype does) is the practical pattern.
- When using OAuth 2.0, the `host` must be `https://api.atlassian.com/ex/jira/{cloudId}`, NOT `https://your-domain.atlassian.net`. Getting this wrong returns 404 on every call.

---

### JQL (Jira Query Language)

The `jira_search_issues` MCP tool takes a raw JQL string from the agent. The agent must be shown JQL examples in the tool's `description` so it composes syntactically valid queries.

**Reference queries (from the prototype build plan):**
```
# All to-do issues
project = KAN AND status = "To Do"

# Issues assigned to the current OAuth user
project = KAN AND assignee = currentUser()

# Issues with a specific label
project = KAN AND labels = "ai-allowed"

# Issues in progress or in review
project = KAN AND status in ("In Progress", "In Review")

# All open issues, newest first
project = KAN AND status != "Done" ORDER BY created DESC

# Recently updated
project = KAN ORDER BY updated DESC

# Text search in summary and description
project = KAN AND text ~ "oauth"
```

**Docs:** <https://developer.atlassian.com/cloud/jira/platform/jql/>

**Sanitization endpoint:** `POST /rest/api/3/jql/sanitize` rewrites a query to be GDPR-safe (replaces display names with account IDs). Useful for the web app's "test rule" button on policy rules that reference JQL. Do not run this on every search — it adds latency.

#### Gotchas

- String values with spaces require double quotes: `status = "In Progress"`, not `status = In Progress`.
- `currentUser()` resolves to the OAuth token's owner, not to the Coodra user or the developer using the agent. If you need per-developer scoping, resolve the Atlassian accountId separately and hardcode it into the JQL.
- Invalid JQL returns HTTP 400 with a parsing error — the `IntegrationClient` should surface this to the agent verbatim so it can correct the query.

---

### Bottleneck (rate-limiting library, optional)

**Package:** `bottleneck`
**Install:** `npm install bottleneck`
**Docs:** <https://github.com/SGrondin/bottleneck>

Used inside the `IntegrationClient` to stay below Atlassian's per-site rate limit:

```typescript
import Bottleneck from 'bottleneck';

const limiter = new Bottleneck({
  maxConcurrent: 10,
  minTime: 20,            // 50 req/sec sustained
  reservoir: 50,          // burst of 50
  reservoirRefreshAmount: 50,
  reservoirRefreshInterval: 1000,
});

const response = await limiter.schedule(() => client.issues.getIssue({ issueIdOrKey: 'KAN-1' }));
```

If this feels like too much for the 1–10 dev scale target, a simpler `p-queue` with `concurrency: 10` is sufficient. The architecture specifies `bottleneck` only because it handles reservoir-style bursts more cleanly, which matches Atlassian's published limits.

---

### Prototype reference — what already works

`v1/jira_test/` contains a working reference implementation:
- `api/jira_client.py` — all 8 tool operations against `/rest/api/3/...` using `requests` + Basic auth
- `api/main.py` — FastAPI wrapper exposing the 8 operations as REST endpoints
- `app.py` — Streamlit frontend with Dashboard / Issue Details / Create / Update / Transitions / Comment / Projects panels
- `MCP-Jira-Test-App-Build-Plan.md` — a self-contained Node/TypeScript build spec (the one being ported to §22 of system-architecture.md)
- `.env` — credentials (never committed; use `.env.example` as template in production)

**Port notes (Python prototype → Node production):**
- `_make_adf()` in Python → `adfWrap()` in TypeScript, same shape
- `requests.post(f"{BASE_URL}/search/jql", ...)` → `client.issueSearch.searchForIssuesUsingJql(...)` via jira.js
- The FastAPI route handlers map 1:1 to the 8 new MCP tool handlers in `apps/mcp-server/src/tools/jira/*.ts`
- Streamlit UI → Next.js dashboard pages under `apps/web/src/app/dashboard/[projectSlug]/integrations/atlassian/`

---

## GitHub Governance & Context Layer

This section covers every GitHub API, library, and wire format the integration at system-architecture §23 depends on. Unlike the JIRA integration (which is one OAuth app + one REST surface), the GitHub integration is richer because CODEOWNERS and branch protection rules become **first-class policy inputs**, not just external entities.

### GitHub REST API v3 + GraphQL v4 — which to use when

**Docs:**
- REST: <https://docs.github.com/en/rest>
- GraphQL: <https://docs.github.com/en/graphql>
- API root (REST, App auth): `https://api.github.com`

**Rule of thumb used in `§23.6`:**
- **REST** for: single-resource reads (`GET /repos/{owner}/{repo}/pulls/{n}`), writes (post comment, transition), simple lists with known shape.
- **GraphQL** for: composite reads where the alternative is 5+ REST calls (`get_pr_context` bundles PR + reviews + checks + reviewers; one GraphQL query vs five REST hops).

Both paths share the same rate limit budget and authenticate identically via `Authorization: Bearer <installation_token>`.

#### Endpoints wrapped by the 10 MCP tools

| MCP tool | API | Endpoint / Query |
|---|---|---|
| `github_get_pr_context` | GraphQL | `pullRequest { ... reviews, latestReviews, commits.statusCheckRollup, files, reviewRequests }` |
| `github_search_prs` | REST | `GET /search/issues?q=is:pr+<filters>` |
| `github_get_pr` | REST | `GET /repos/{owner}/{repo}/pulls/{pull_number}` |
| `github_list_pr_comments` | REST | `GET /repos/{owner}/{repo}/pulls/{n}/comments` + `GET /repos/{owner}/{repo}/issues/{n}/comments` |
| `github_get_codeowners` | local (graph index) | reads `code_owner_rules` table |
| `github_get_branch_protection` | local (graph index) | reads `branch_protection_rules` table |
| `github_list_my_reviews` | GraphQL | `viewer { pullRequests(states: OPEN, first: 50) }` filtered where `reviewRequests.nodes` contains viewer |
| `github_get_blame` | GraphQL | `repository.object(expression:"HEAD:{path}") { ... on Blob { blame(path:) { ranges { commit, startingLine, endingLine } } } }` |
| `github_get_issue` | REST | `GET /repos/{owner}/{repo}/issues/{n}` |
| `github_post_pr_comment` | REST | `POST /repos/{owner}/{repo}/issues/{n}/comments` (a PR is an issue under the hood for comments) |

#### Error responses (same handling as JIRA, slightly different codes)

| HTTP | Meaning | Handling in `GitHubClient` |
|---|---|---|
| 304 | ETag match (conditional request) | Return cached body. Does NOT count against rate limit. |
| 401 | Token expired / invalid | Mint a new installation token, retry once. If still 401, mark `integrations.status='expired'`. |
| 403 with `x-ratelimit-remaining: 0` | Primary rate limit exhausted | Open breaker for `Retry-After` seconds (default 60 s). |
| 403 with message "secondary rate limit" | Secondary rate limit | Open breaker for 60 s regardless of `Retry-After`. |
| 404 | Resource not found | Return `{ ok: true, value: null }`. Not an error — absence. |
| 410 | Resource gone (e.g., deleted PR) | Return `{ ok: true, value: null }`. |
| 422 | Validation failed (e.g., bad JQL-like query) | Return `{ error: 'bad_request', retryable: false }`. |
| 5xx | GitHub outage | Retry twice with exponential backoff. Breaker opens after 5 consecutive failures. |

---

### GitHub App authentication

**Docs:**
- App concepts: <https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/about-creating-github-apps>
- Installation tokens: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app>

A GitHub App has two credentials:
- **App ID** + **private key (PEM)** — used to mint a short-lived JWT (10-min validity).
- **Installation ID** — per-org value obtained from the install flow.

The 10-min JWT signs a single call to `POST /app/installations/{installationId}/access_tokens`, which returns an **installation access token** valid for 1 hour. That installation token is what every subsequent API call uses.

#### Using `@octokit/auth-app`

**Package:** `@octokit/auth-app`
**Install:** `npm install @octokit/auth-app @octokit/rest`
**Docs:** <https://github.com/octokit/auth-app.js>

```typescript
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: Number(process.env.GITHUB_APP_ID),
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,       // PEM; multi-line, base64-encoded in env is common
    installationId: Number(integration.cloudId),           // from integrations.cloud_id
    clientId: process.env.GITHUB_APP_CLIENT_ID,            // optional, for user-to-server flows
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,    // optional
  },
});

// auth-app caches the installation token internally; subsequent calls reuse it until ~60s before expiry.
const { data: pr } = await octokit.pulls.get({ owner: 'acme', repo: 'web', pull_number: 123 });
```

**Manual token minting (for scheduled workers that need to pass the token downstream):**
```typescript
const appAuth = createAppAuth({ appId, privateKey });
const { token, expiresAt } = await appAuth({
  type: 'installation',
  installationId: integration.cloudId,
});
// Persist { token, expiresAt } in integration_tokens; reuse until 5 min before expiry.
```

#### GitHub App webhooks (App-level secret, not per-install)

GitHub Apps have a **single webhook secret** configured in the App's settings page. Every installation's events are signed with the same secret. This is different from Atlassian, where each webhook registration has its own secret.

Consequence for the architecture: `integrations.webhook_secret` is NOT used for GitHub (it's NULL); the secret is a process-wide env var `GITHUB_WEBHOOK_SECRET`.

#### Permissions requested (App manifest snippet)

```yaml
default_permissions:
  contents: read
  metadata: read
  pull_requests: write      # read + write (for posting comments)
  issues: read
  discussions: read
  checks: read
  members: read
  administration: read      # required for Rulesets API

default_events:
  - pull_request
  - pull_request_review
  - pull_request_review_comment
  - push
  - issues
  - issue_comment
  - check_suite
  - check_run
  - branch_protection_rule
  - repository_ruleset
  - membership
  - team
  - installation
  - installation_repositories
```

#### Gotchas

- **The App's webhook URL must be HTTPS and publicly reachable.** GitHub will not deliver to `http://` or `localhost`. Development uses a tunnel (e.g., `smee.io`, `ngrok`).
- **Private key line-break handling.** Reading the PEM from an env var trips on `\n` vs real newlines. Use `process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n')` or base64-encode the PEM in the env and decode at startup.
- **The App's JWT audience** is implicit in Octokit's auth strategy — do NOT set `aud` manually; the library handles it.
- **Installation rate limit pooling.** An org with many installations of the same App each has their own 5,000 req/hr bucket. Don't aggregate across installations when planning capacity.
- **Installation tokens only work for the repos the App has been granted access to.** If a user later adds a repo to the App via "Install & authorize → Configure → Repository access", a new `installation_repositories.added` webhook fires. Listen for it.

---

### Fine-grained Personal Access Tokens (solo mode)

**Docs:** <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token>

Fine-grained PATs were introduced to replace classic PATs (which had repo-global scopes and coarse permissions). Fine-grained PATs are scoped to a specific set of repositories and have per-resource permission levels.

**Minimum permissions for solo mode** (mirrors the team-mode GitHub App):

```
Repository permissions:
  Contents:        Read-only
  Metadata:        Read-only (mandatory)
  Pull requests:   Read and write
  Issues:          Read-only
  Discussions:     Read-only
  Checks:          Read-only

Organization permissions (if the user owns an org):
  Members:         Read-only
```

**Lifetime:** up to 1 year, set by the user at generation time. Coodra's solo UI should remind the user 7 days before expiry.

**Authentication:** `Authorization: Bearer github_pat_...` on every request — same Octokit setup as team mode, but with `auth: 'github_pat_...'` instead of the `createAppAuth` strategy.

**Rate limit:** 5,000 req/hr per user. `GET /rate_limit` returns the remaining budget for the current authenticated identity.

#### Gotchas

- Fine-grained PATs do NOT work with GitHub Apps' endpoints — if the user accidentally generates a classic PAT, the `GET /app` endpoint (and others gated on App auth) will 404.
- Some older REST endpoints still require classic PAT scopes (`repo`, `workflow`). For Coodra's scope (PR reads, CODEOWNERS, branch protection, comments) fine-grained is enough; check a new endpoint before adding it.

---

### GitHub Webhooks — Signature Verification

**Docs:** <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>

#### Header

GitHub signs every webhook delivery with HMAC-SHA-256 (SHA-1 is deprecated and should be ignored):

```
X-Hub-Signature-256: sha256=<hex-encoded-hmac>
X-GitHub-Event: pull_request
X-GitHub-Delivery: <UUID per delivery>          ← use as BullMQ jobId for idempotency
X-GitHub-Hook-Installation-Target-ID: <app id>
X-GitHub-Hook-Installation-Target-Type: integration
```

#### Verification

Identical algorithm to JIRA's webhooks, but using the **App-wide** `GITHUB_WEBHOOK_SECRET`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyGitHubWebhook(
  rawBody: Buffer,
  headerSig: string,
  secret: string,
): boolean {
  if (!headerSig?.startsWith('sha256=')) return false;
  const received = Buffer.from(headerSig.slice('sha256='.length), 'hex');
  const computed = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === computed.length && timingSafeEqual(received, computed);
}
```

**Critical:** verify against the **raw body bytes** before any JSON parsing + re-stringification. Octokit's `@octokit/webhooks` middleware handles this automatically — prefer it over rolling your own.

#### Using `@octokit/webhooks` (recommended)

**Package:** `@octokit/webhooks` + `@octokit/webhooks-types`
**Install:** `npm install @octokit/webhooks @octokit/webhooks-types`
**Docs:** <https://github.com/octokit/webhooks.js>

```typescript
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';

const webhooks = new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET! });

webhooks.on('pull_request.opened', async ({ id, name, payload }) => {
  await bullmq.add('github-pr-event', { deliveryId: id, event: name, payload }, {
    jobId: id,                              // X-GitHub-Delivery UUID
  });
});

webhooks.on('push', async ({ id, payload }) => {
  const changed = payload.commits?.flatMap(c => c.modified ?? []) ?? [];
  if (changed.includes('.github/CODEOWNERS')) {
    await bullmq.add('github-repo-refresh', { repo: payload.repository.full_name, sha: payload.after });
  }
});

// Mount as middleware on an Express/Hono app; it validates signature + parses body.
app.use(createNodeMiddleware(webhooks, { path: '/v1/webhooks/github' }));
```

The library handles signature verification, event dispatch, and the correct typing for each event via `@octokit/webhooks-types`.

#### Event types consumed (mapped in system-architecture §23.8)

- `installation`, `installation_repositories` — App lifecycle.
- `push` — CODEOWNERS refresh trigger (check `commits[].modified` for the path).
- `pull_request`, `pull_request_review`, `pull_request_review_comment` — PR context refresh.
- `check_suite`, `check_run` — CI status updates.
- `branch_protection_rule`, `repository_ruleset` — protection cache refresh.
- `membership`, `team` — team graph refresh.
- `issues`, `issue_comment` — issue timeline surfacing.
- `ping` — install-time reachability check, respond 200 and ignore.

---

### CODEOWNERS — syntax, semantics, parsing

**Official docs:** <https://docs.github.com/en/repositories/managing-your-repositories-settings-and-features/customizing-your-repository/about-code-owners>

CODEOWNERS is a plain-text file whose precedence within the repo is:
1. `.github/CODEOWNERS` (the most common location)
2. `CODEOWNERS` at the root
3. `docs/CODEOWNERS`

GitHub uses the first one it finds. The parser in `@coodra/shared/codeowners.ts` should check all three.

#### Syntax (the complete grammar)

```
# Comments start with '#'
# Each non-comment line is:  <pattern>  <owner>...
#
# <pattern> uses gitignore glob syntax:
#   *.js              — any .js file anywhere
#   /apps/web/**      — rooted match, recursive
#   *.md              — any .md anywhere
#   docs/*            — direct children only
#   /scripts          — the literal file or dir 'scripts' at repo root
#
# <owner> forms:
#   @username         — a single user
#   @org/team-slug    — a team within an org
#   user@example.com  — a verified email (less common)
#
# Last matching rule wins (unlike .gitignore where first wins).

* @default-owner
/apps/web/** @org/frontend
/packages/auth/** @org/security @alice
*.md @org/docs
```

#### Parser rules (normative, matching GitHub's semantics)

1. Lines ending with `\` continue to the next line (line continuation). Rare but documented.
2. Trailing whitespace in a pattern is stripped before matching.
3. Owners separated by whitespace are ORed; any one of them on a PR satisfies "code owner review".
4. Invalid owners (user doesn't exist, team not visible) are silently ignored by GitHub. The parser should record them as warnings.
5. **Last-match-wins.** Iterate the parsed rules from bottom to top and return the first pattern that matches the file path.

#### Libraries

- **`codeowners`** (npm package, ~300 weekly downloads): small, lightweight, matches GitHub's docs. Good starting point. Verify against edge cases (line continuation, escaped globs).
- **`minimatch`** (npm package, ~200M weekly downloads, dev dep of npm itself): for the glob matching primitive. Pair with a custom file reader.

Recommendation: write a pure-function parser (~100 LoC) using `minimatch` for the glob. Keep it testable; do not depend on a third-party CODEOWNERS lib that may lag GitHub's semantics.

#### Gotchas

- **Leading slash matters.** `/apps/web/**` is rooted at the repo root. `apps/web/**` matches `apps/web/` anywhere in the tree.
- **Trailing slash on a pattern** means "directory only," e.g., `apps/` matches the directory but not files whose name is `apps`.
- **Nested CODEOWNERS** files (e.g., `apps/web/.github/CODEOWNERS`) are **not** supported by GitHub. Only one file is consulted per repo.
- **Team names are case-sensitive** in the enforcement API but not in the CODEOWNERS file (GitHub lowercases them at resolve time). Normalize to lowercase in the index.

---

### Branch protection & Rulesets

GitHub exposes protection rules through **two overlapping APIs**. Both must be queried, and the results merged, to get the full picture.

#### Legacy Branch Protection

**Endpoint:** `GET /repos/{owner}/{repo}/branches/{branch}/protection`
**Docs:** <https://docs.github.com/en/rest/branches/branch-protection>

Returns required status checks, required reviewers count, `require_code_owner_reviews`, `dismiss_stale_reviews`, `enforce_admins`, `restrictions` (who can push). This API has been superseded but is still the only one that reports protection configured via the old UI.

#### Modern Rulesets

**Endpoint:** `GET /repos/{owner}/{repo}/rulesets` + `GET /repos/{owner}/{repo}/rulesets/{id}`
**Docs:** <https://docs.github.com/en/rest/repos/rules>
**Required permission:** `administration: read` on the App or PAT.

Rulesets are the modern replacement — they can target multiple branches via patterns (`refs/heads/release/*`), apply org-wide, and support more rule types (e.g., `commit_message_pattern`, `tag_name_pattern`). A single repo can have both legacy protection AND rulesets simultaneously; the enforced behavior is the UNION.

#### Merging strategy (for `branch_protection_rules` table)

```
fetchBoth(repo, branch):
  legacy   = GET /repos/.../branches/{branch}/protection
  rulesets = GET /repos/.../rulesets where target='branch' and ref matches branch
  
  merged = {
    required_reviewers:         max(legacy.required_reviewers, rulesets.*.required_approving_review_count),
    required_checks:            union(legacy.required_checks, rulesets.*.required_status_checks),
    require_code_owner_review:  legacy.require_code_owner_review OR rulesets.*.require_code_owner_review,
    restricts_push_to:          union(legacy.restrictions.users/teams, rulesets.*.bypass_actors),
    ruleset_id:                 rulesets.*.id if present else null,
    raw:                        { legacy, rulesets }  ← for audit
  }
```

The `raw` JSONB preserves the original responses so future fields don't require schema migration.

#### Gotchas

- The legacy branch protection endpoint returns 404 for branches with NO protection. Treat 404 as "no protection," not as an error.
- Rulesets can target organization-wide; those rulesets are fetched via `GET /orgs/{org}/rulesets` and apply to every repo in the org. Include them in the merge.
- `require_code_owner_reviews` (legacy) vs `require_code_owner_review` (rulesets) — singular/plural differs. Normalize on write.
- Rulesets can be "evaluation mode" (log-only, not enforced). The raw JSON includes `enforcement: 'active' | 'evaluate' | 'disabled'` — filter on `active` before treating as a policy input.

---

### Octokit suite — the full library set

The Coodra GitHub client uses multiple Octokit packages. All are maintained by the GitHub DX team.

| Package | Purpose | Install |
|---|---|---|
| `@octokit/rest` | REST API client | `npm install @octokit/rest` |
| `@octokit/graphql` | GraphQL API client | `npm install @octokit/graphql` |
| `@octokit/auth-app` | GitHub App JWT + installation token | `npm install @octokit/auth-app` |
| `@octokit/webhooks` | Webhook signature verification + event types | `npm install @octokit/webhooks @octokit/webhooks-types` |
| `@octokit/plugin-throttling` | Auto-handling of primary + secondary rate limits | `npm install @octokit/plugin-throttling` |
| `@octokit/plugin-retry` | Retry on 5xx + rate-limit responses | `npm install @octokit/plugin-retry` |

**Minimum wiring for Coodra:**

```typescript
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';

const PatchedOctokit = Octokit.plugin(throttling, retry);

const octokit = new PatchedOctokit({
  authStrategy: createAppAuth,
  auth: { appId, privateKey, installationId },
  throttle: {
    onRateLimit: (retryAfter, options) => {
      // Let cockatiel handle the breaker; we just don't auto-retry here.
      return false;
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      return false;
    },
  },
  retry: {
    enabled: false,   // cockatiel handles retries; don't double up.
  },
});
```

#### Conditional requests with ETag

Octokit does NOT cache ETags out of the box. Wire a custom `request.hook` that stores ETags in Redis (team) or better-sqlite3 (solo):

```typescript
octokit.hook.wrap('request', async (request, options) => {
  const key = `github:etag:${options.url}:${options.method}`;
  const cached = await kv.get(key);                                // Redis or SQLite
  if (cached) {
    options.headers ||= {};
    options.headers['if-none-match'] = cached.etag;
  }
  try {
    const response = await request(options);
    if (response.headers.etag) {
      await kv.set(key, { etag: response.headers.etag, body: response.data }, { EX: 3600 });
    }
    return response;
  } catch (err: any) {
    if (err.status === 304 && cached) {
      return { status: 200, headers: {}, data: cached.body, url: options.url };
    }
    throw err;
  }
});
```

304 responses do NOT count against the rate limit — this is GitHub's documented incentive to use conditional requests, and the single biggest lever for staying under 5,000 req/hr.

#### Gotchas across Octokit

- `@octokit/rest` and `@octokit/graphql` are separate packages; both need to be installed if you use both.
- The `throttling` plugin's `onRateLimit` default behavior is to retry until success. We override it because cockatiel is already the breaker. Disable plugin-level retries whenever you have an external breaker.
- `octokit.hook.wrap('request', ...)` fires for every Octokit method, including GraphQL. Scope the hook's logic to `options.method === 'GET'` for ETag caching.
- TypeScript types for `@octokit/webhooks-types` are generated from GitHub's OpenAPI spec and can lag behind newly-added event fields. Cast-to-`any` at the boundary for fields not yet in the types, but log a warning to catch them.

---

### GitHub rate limits — operational numbers

| Tier | Primary limit | Secondary limit triggers |
|---|---|---|
| Authenticated user (PAT) | 5,000 req/hr | >60 concurrent, >900 points/min on GraphQL, many 5xx from this client |
| GitHub App installation | 5,000 req/hr (<20 members); up to 12,500 req/hr (≥20 members) | Same as above |
| GraphQL | Point-based, 5,000 points/hr | 2,000 points over a rolling minute |
| Search API | 30 req/min (lower than normal!) | Scraping behavior |
| Unauthenticated | 60 req/hr | Basically immediate |

**Monitoring:** every REST response includes:
```
X-RateLimit-Limit:     5000
X-RateLimit-Remaining: 4872
X-RateLimit-Reset:     1712678400       (unix timestamp)
X-RateLimit-Used:      128
X-RateLimit-Resource:  core
```

Log these on every request's `finally` handler with pino so you can alert when `remaining` falls below 10% with >20 min to reset.

**GraphQL rate-limit probe:** the `rateLimit` field is free (no points cost) and returns the current bucket:

```graphql
query { rateLimit { limit cost remaining resetAt } }
```

Include it in the `github_list_my_reviews` query by concatenating — you get the status for free.

#### Gotchas

- **Search API rate limit is much lower** (30/min). `github_search_prs` must be used sparingly and results cached aggressively.
- **Secondary rate limits are not documented numerically.** GitHub explicitly refuses to publish the exact thresholds. The circuit breaker handling makes this a non-issue operationally; just don't burst.
- **GraphQL scoring** is computed per-query; the `cost` field on `rateLimit` tells you what a query just cost. Use this to find expensive queries.

---

### Comment body format (Markdown, not ADF)

Unlike JIRA/Atlassian, GitHub comment bodies are **native GitHub-flavored Markdown** — no ADF, no wrapping. This makes Context Pack → PR comment simpler than the JIRA equivalent.

**GitHub-flavored Markdown extensions used:**
- Task lists: `- [ ]`, `- [x]`
- Code blocks with language: ` ```typescript `
- Autolinks for `#123` → PR/issue link within the repo
- Autolinks for `@username` and `@org/team` → mentions
- Tables, strikethrough (`~~text~~`), footnotes

The `github_post_pr_comment` tool does a light sanitization pass to prevent accidental mentions (e.g., a user's code that contains `@everyone` shouldn't ping an org). Transform `@username` → `` `@username` `` inside fenced code blocks only.

---

### Library version pinning

| Package | Minimum version | Why |
|---|---|---|
| `@octokit/rest` | ^20.0.0 | Fully typed TS; earlier versions had patchy types |
| `@octokit/graphql` | ^7.0.0 | Uses Node 18+ fetch; pairs with current Octokit |
| `@octokit/auth-app` | ^6.0.0 | Handles installation token caching internally |
| `@octokit/webhooks` | ^12.0.0 | X-Hub-Signature-256 only (SHA-1 removed) |
| `@octokit/plugin-throttling` | ^8.0.0 | Matches Octokit v20 plugin interface |
| `@octokit/plugin-retry` | ^6.0.0 | Matches Octokit v20 plugin interface |
| `minimatch` | ^9.0.0 | For CODEOWNERS glob matching; breaking changes from v8 |
| TypeScript | ^5.0.0 | Required by modern Octokit types |

Run `npm view <pkg> version` at implementation time and update the pins. Octokit ecosystem versions are tightly coupled — upgrade the whole suite together.

---

### Things that require verification before implementation

- **GitHub App event list.** The list in §23.8 is a snapshot; check [docs.github.com/en/webhooks/webhook-events-and-payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) before finalizing the App manifest.
- **Rulesets API stability.** The Rulesets API was GA'd in 2023 but continues to gain fields. The `branch_protection_rules.raw` JSONB column is there specifically for new fields that don't need schema migrations to capture.
- **Fine-grained PAT deprecations.** Classic PATs are being phased out. Solo mode must use fine-grained from the start.
- **Octokit plugin interface versions.** The `throttling` and `retry` plugins have re-versioned to match Octokit majors more than once. If Octokit v21 drops, re-pin the plugins.

---

## Things that require explicit manual verification

Per the architecture and limitations of this research:

- **Next.js 15**: Confirm that version exists and is stable; adjust to latest major and follow official migration guides. The architecture’s assumption of “Next.js 15” is speculative and must be validated. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)
- **Graphify CLI**: Name, CLI arguments, and `graph.json` schema stability across versions. The architecture explicitly treats this as an open question. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/28356926/e4e460e8-fe3c-4f55-b291-2a78271d88e6/system-architecture.md?AWSAccessKeyId=ASIA2F3EMEYE3MY3T5JN&Signature=8FIvmLoCYSJ6NxP7DhxVc8Qpjc0%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEPP%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJGMEQCIFiExgsPLb9lUsn%2FEwIaSRcBrulhBweWpop3MwxGbAkIAiBvRShUUTiKmou%2Fxf%2FvuZ7FlEltkCcY6VJI58Sbs8X7ayr8BAi8%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F8BEAEaDDY5OTc1MzMwOTcwNSIMZvv0SYJ8%2FV%2B1ereyKtAE7Xba3%2Fx3vMytWOuP2TCaaCFfm0aQbCHzTPq8x9tMeiRrWJyCPKNapsvKy2UZWb388fNHumdsI0YEx4ufPPfRwWppGL%2F5TE7slRt5avdicaArLFv%2BewgnPZRDGqOtUaOarh6maUTslgqxpGXMjk5YZ109WXl3IshUWWMS7rypot7gGdevUYMWNutAIplJazSWhCGRGIEvIqKzdxpun1XatGGcGB7UlWFN%2BDHFJ3ITV4oDqEUTlz%2BsOYjE4lxuc8QIt7AlTsAwUkcBggr4kJNO7RMvFJFW1CSxplif46eBFhmrI%2FBPKXgSbNxE%2Frwbrqyj5mKWSqtwjWk%2Fr5VgSEUspEPrJzB7n63%2B1CXsnJ3TW5ZTm9frVdtquRthMj5LmuS7vj9zap7AFOW3YKjSz4AfiqZAgwvGEyWVua7So0tQnxdvolK0HJS%2BuXalbiB%2BxgCHC%2Bv9WqgPYk7BIP%2BO1bWUK2WFzn%2F1nYd1U0nQACzMWpXoluNcOdNlCiimpHirx3HxtPXMWLZMlyGxRHOjvT0ZCvFt4iN1j%2FICYw2rDbPBOvKzCEGs9u6IUOQFHMOX9zpXsoQ5CVhiJ%2FXb7N8Jj0D1BSm8lb%2BRrJABTFJjjM8Sv6efkYg9kyGtoSof5ThCtHiwgdYS2q%2BDbGuNAU8QHuuDfLGP0njbgtgPWjIvpv6sq8jRSGQbZkZSds8uzIZ%2Bs0ZvSP80ikQxjCb2ed8RvwjNW5Y2%2BabFmXNUPpiyPGB4ZG8d0gNbiuJ4%2FwjTNxVOcd53SivcoEdjJX9QfZ1Xpz9svjCW%2BILPBjqZAffWM775KKTJPS30orTm4AuyrQihe%2BiGVdl30Vvn9qKd8nA3VSsnC3Jwl%2Fu1B36pLAEtMsvBPvY3eGjIk8sbayXnqSbDSg6%2FRV74wy1nd85FMy%2BOeJxXshopaKehnOnZ7IaQX3ucr47uYeU9nHf9JcXbquA36ncZIkSvpwl1glhPK1f4DO1vns2E4NL1aAitQL%2FT8sZlZRlh8g%3D%3D&Expires=1776336983)
- **Exact npm/pip versions** for libraries where only package docs, not versions, were retrieved (e.g., `bullmq`, `postgres`, `drizzle-orm`, `drizzle-kit`, `express` minor version, `hono`). Use `npm view <pkg> version` or `pip index versions <pkg>` to pin.  
- **Supabase Supavisor behavior** with Postgres.js `prepare: false`: while architecture depends on this, verify against Supabase’s latest guidance for Postgres.js clients.  
- **Jira `/search/jql` deprecation timeline**: Atlassian changelog `CHANGE-2046` flags the endpoint as "currently being removed" — re-check the changelog before release and plan for the final removal date.
- **Jira webhook `x-hub-signature` header casing**: some community reports indicate case-sensitivity differences between environments; always look up the header case-insensitively and verify with a live webhook before shipping.
- **Atlassian OAuth refresh-token rotation policy**: the current docs say refresh tokens rotate on every exchange — re-verify at implementation time, because changing this would require storing the previous refresh token until the new one is confirmed.
- **jira.js v4 exact latest version**: run `npm view jira.js version` before pinning. The build plan specifies `^4.0.0` but API details (especially around OAuth 2.0 auth shape) can shift within a major.
- **Atlassian per-site rate limits**: the `~50 req/sec sustained, burst 10/sec` figure in this doc is a community estimate, not official. Use the `X-RateLimit-*` response headers Atlassian returns to calibrate the `bottleneck` / `p-queue` config at runtime.
- **Gemini model GA status**: `gemini-2.5-flash-preview-04-17` is a preview model — before shipping, switch to the stable `gemini-2.5-flash` model name and re-test function calling.

***

This reference should give a coding agent enough concrete APIs, configs, and wire-level details to implement Coodra v2 as described, while clearly marking areas where the architecture’s assumptions must be rechecked against current official docs before implementation. [modelcontextprotocol](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)