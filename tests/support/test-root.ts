import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

/**
 * Where a test puts directories whose *writability* is part of what is being asserted —
 * and deliberately **not** `os.tmpdir()`.
 *
 * Codex's `workspace-write` sandbox grants `$TMPDIR` and `/tmp` unconditionally, whatever
 * is on its writable list. Two things follow, and they are why this is shared between the
 * unit harness and the contract suite rather than restated in each:
 *
 * - **A contract assertion about where the engine may write is vacuous in `$TMPDIR`.** The
 *   write succeeds on the temp-directory grant alone, so the test passes without the
 *   mechanism it names working at all.
 * - **`preflight` refuses to start** against a Skills directory in a temporary location,
 *   because that voids the authorship rule ADR-0004 depends on (`src/vault/skills.ts`). A
 *   harness in `$TMPDIR` would have to either skip that check or fail it.
 *
 * Measured rather than reasoned about: the first run of build/15's verification probe
 * reported that the sandbox had no write boundary whatsoever. It was sited in `$TMPDIR`.
 *
 * Repo-local and gitignored, so these are real directories in a real place while still
 * being cleaned up per test.
 */
export async function testTempDir(prefix: string): Promise<string> {
  const root = path.resolve(import.meta.dirname, "..", "..", ".test-tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
}
