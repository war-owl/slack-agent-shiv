import { readFile } from "node:fs/promises";
import { prepareRepositoryCheckout } from "./checkout.ts";
import type { RepositoryRestoration } from "./checkout.ts";

interface CheckoutCommandConfig {
  workspace: string;
  credentialEnvVar: string | undefined;
  repositories: Record<string, string>;
  restorations?: Record<string, RepositoryRestoration>;
}

async function main(): Promise<void> {
  const [configPath, repository, ...extra] = process.argv.slice(2);
  if (configPath === undefined || repository === undefined || extra.length > 0) {
    throw new Error("Usage: checkout owner/repository");
  }

  const config = JSON.parse(await readFile(configPath, "utf8")) as CheckoutCommandConfig;
  const remote = config.repositories[repository];
  if (remote === undefined) {
    throw new Error(
      `${repository} is not configured. Available repositories: ` +
        `${Object.keys(config.repositories).join(", ") || "(none)"}`,
    );
  }

  const prepared = await prepareRepositoryCheckout({
    workspace: config.workspace,
    repository,
    remote,
    credentialEnvVar: config.credentialEnvVar,
    env: process.env,
    restoration: config.restorations?.[repository],
  });
  process.stdout.write(
    `${prepared.repository} is ready at ${prepared.checkout} ` +
      `(default branch: ${prepared.defaultBranch}).\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
