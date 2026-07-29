import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOOKS_DIR = ".open-agent-hooks";

/**
 * Install the checkout-local accident guard.
 *
 * This is defence-in-depth, not a boundary: `--no-verify`, a one-off hooksPath, editing the
 * hook, or bypassing git entirely all defeat it. GitHub branch protection is the boundary.
 */
export async function installGitSafetyHook(options: {
  checkout: string;
  defaultBranch: string;
}): Promise<void> {
  await run("git", ["check-ref-format", "--branch", options.defaultBranch]);
  const hooksDir = path.join(options.checkout, HOOKS_DIR);
  const hookPath = path.join(hooksDir, "pre-push");
  await mkdir(hooksDir, { recursive: true });
  await writeFile(hookPath, prePushHook(options.defaultBranch), "utf8");
  await chmod(hookPath, 0o755);
  await run("git", ["-C", options.checkout, "config", "core.hooksPath", HOOKS_DIR]);
}

function prePushHook(defaultBranch: string): string {
  const protectedRef = shellSingleQuote(`refs/heads/${defaultBranch}`);
  return `#!/usr/bin/env bash
set -uo pipefail
protected=${protectedRef}
status=0
while read -r local_ref local_oid remote_ref remote_oid; do
  [ -z "\${remote_ref:-}" ] && continue
  if [[ "$remote_ref" == "$protected" ]]; then
    echo "blocked: push to protected ref '$remote_ref'"
    status=1
    continue
  fi
  if [[ "$local_oid" =~ ^0+$ ]]; then
    echo "blocked: deletion of remote ref '$remote_ref'"
    status=1
    continue
  fi
  [[ "$remote_oid" =~ ^0+$ ]] && continue
  if ! git merge-base --is-ancestor "$remote_oid" "$local_oid"; then
    echo "blocked: non-fast-forward push to '$remote_ref'"
    status=1
  fi
done
exit $status
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
