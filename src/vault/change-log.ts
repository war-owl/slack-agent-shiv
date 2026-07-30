import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { reasonFor } from "../failure.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/log.ts";
import type { Thread } from "../thread.ts";

const VAULT_CHANGE_LOG_FILENAME = "vault-changes.jsonl";

export interface VaultChangeRecord {
  action: string;
  subject: string;
  diff: string | undefined;
  detail: string | undefined;
  thread: Thread;
  jobId: string;
}

export interface VaultChangeLog {
  /**
   * Append one complete Vault change. A logging failure is reported server-side and does
   * not turn already-completed work into a failed Job.
   */
  append(record: VaultChangeRecord): Promise<void>;
}

export function vaultChangeLogFile(stateDir: string): string {
  return path.join(stateDir, VAULT_CHANGE_LOG_FILENAME);
}

export function openVaultChangeLog(deps: {
  filePath: string;
  clock: Clock;
  log: Logger;
}): VaultChangeLog {
  // All Jobs share this chain, so concurrent Vault windows cannot interleave records.
  let pending: Promise<void> = Promise.resolve();

  return {
    append(record): Promise<void> {
      const next = pending.then(async () => {
        await mkdir(path.dirname(deps.filePath), { recursive: true });
        await appendFile(
          deps.filePath,
          `${JSON.stringify({
            at: new Date(deps.clock.now()).toISOString(),
            action: record.action,
            subject: record.subject,
            thread: `${record.thread.channel}/${record.thread.ts}`,
            job: record.jobId,
            ...(record.detail === undefined ? {} : { detail: record.detail }),
            ...(record.diff === undefined ? {} : { diff: record.diff }),
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        deps.log.info(`Vault change logged: ${record.action} · ${record.subject}`);
      });
      pending = next.catch((error: unknown) => {
        deps.log.warn(
          `Could not append a Vault change to ${deps.filePath}: ${reasonFor(error)}. ` +
            `${record.action}: ${record.subject}`,
        );
      });
      return pending;
    },
  };
}
