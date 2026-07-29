import { RECORDED_CODEX_VERSION, type Config } from "./config.ts";
import type { Engine } from "./ports/engine.ts";
import type { Logger } from "./ports/log.ts";
import type { McpInventoryProber } from "./ports/mcp.ts";
import { readRootNote, rootNoteConcerns, ROOT_NOTE_FILENAME } from "./vault/root.ts";
import {
  credentialConcerns,
  proceduresIn,
  readSkills,
  skillsLocationProblems,
} from "./vault/skills.ts";

/**
 * What the instance checks before it accepts its first mention.
 *
 * Everything it finds goes to the log, because the log is what a self-hoster reads
 * at startup. Conditions that must not be survivable throw — ticket 08 adds the
 * first of those, a connector whose tool inventory no longer matches its pin.
 *
 * v1 ships **no version pin**: the instance runs against whatever Codex is
 * installed, records the version, and warns when it has drifted from the version
 * this project was tested against. That report is not optional — Codex ships
 * multiple alphas a day and has already removed flags a wrapper would plausibly
 * depend on, so "it broke overnight and nobody can see why" is the failure mode this
 * exists to make visible.
 */
export async function runPreflight(deps: {
  config: Config;
  engine: Engine;
  inventoryProber: McpInventoryProber;
  log: Logger;
}): Promise<void> {
  const engineVersion = await deps.engine.version();
  deps.log.info(`Codex version ${engineVersion} (recorded: ${RECORDED_CODEX_VERSION})`);
  if (engineVersion !== RECORDED_CODEX_VERSION) {
    deps.log.warn(
      `The installed Codex is ${engineVersion}, but this project was built and tested ` +
        `against ${RECORDED_CODEX_VERSION}. v1 pins no version, so the instance will run ` +
        "anyway — but if it behaves strangely, this is the first thing to suspect. " +
        "Run `pnpm test:contract` to check the engine still behaves as expected.",
    );
  }

  // Reported because they are the wrapper's alone — the engine has no ceiling of its
  // own — and because a self-hoster who has lowered one wants to see that it took.
  const bounds = deps.config.bounds;
  deps.log.info(
    `Bounds: ${Math.round(bounds.turnTimeoutMs / 1000)}s per Turn, ` +
      `${bounds.maxTurnsPerJob} Turns per Job, ` +
      `${bounds.tokenBudgetPerJob} tokens per Job. A Job that hits one is stopped.`,
  );

  // Said once at startup as well as once per Job, because the two readers are different
  // people at different moments. A per-Job warning reaches whoever is watching the logs
  // while a Job runs; this reaches the person who has just edited their Vault and
  // restarted, which is exactly when a Root note full of prose gets written.
  const root = await readRootNote(deps.config.notesDir);
  deps.log.info(
    root.exists
      ? `Vault: ${deps.config.notesDir} — Root note has ${root.links.length} hub link(s)`
      : `Vault: ${deps.config.notesDir} — no ${ROOT_NOTE_FILENAME} yet, so nothing is on the map`,
  );
  for (const concern of rootNoteConcerns(root, deps.config.notesDir)) deps.log.warn(concern);

  await checkSkills(deps);

  for (const server of deps.config.mcpServers) {
    const inventory = await deps.inventoryProber.probe(server);
    deps.log.info(
      `Connector ${server.name} advertises ${inventory.tools.length} tools: ` +
        inventory.tools.join(", "),
    );

    // A tool named as a Write that the server does not have is a typo, and its cost is
    // silence: every use of the tool that was *meant* would go unrecorded in the Thread.
    // Cheap to catch here, since the inventory has just been fetched anyway.
    const unknown = server.writeTools.filter((tool) => !inventory.tools.includes(tool));
    if (unknown.length > 0) {
      deps.log.warn(
        `Connector ${server.name} is configured with writeTools it does not advertise: ` +
          `${unknown.join(", ")}. Nothing uses those names, so check the spelling — a ` +
          "tool that writes but is not listed leaves no record in the Thread when it does.",
      );
    }
  }
}

/**
 * The Skills location, and whether it can keep the one promise it makes.
 *
 * **The location check throws.** Everything else in this function is a report, because
 * everything else in preflight describes an instance that will work. A Skills directory
 * the engine can write to is different in kind: the instance runs perfectly, the
 * documentation says Skills are human-authored, and they are not. ADR-0004's amendment is
 * the only thing standing between a poisoned Job and a command running in a different
 * Thread with a different audience, and it is enforced by nothing except this directory
 * being off the writable list — so an arrangement that voids it must not start.
 *
 * The credential scan only warns. That asymmetry is argued in `vault/skills.ts`: one is
 * the project failing to deliver its own guarantee, the other is the self-hoster's
 * credential in the self-hoster's vault.
 */
async function checkSkills(deps: { config: Config; log: Logger }): Promise<void> {
  const problems = await skillsLocationProblems({
    skillsDir: deps.config.skillsDir,
    notesDir: deps.config.notesDir,
    workspaceRoot: deps.config.workspaceRoot,
  });
  if (problems.length > 0) {
    throw new Error(
      "The Skills directory is not in a place where it can stay read-only to the " +
        "coworker, so the instance is stopping rather than running with an authorship " +
        `rule that is not in force:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n` +
        "Skills must be a sibling of your Notes directory, both under the directory you " +
        "open in Obsidian, and not in a temporary directory. See docs/skills.md.",
    );
  }

  // Counted as procedures rather than as files, so the README that explains how to write
  // one is not reported as one — it is also what the coworker is not told about.
  const procedures = proceduresIn(await readSkills(deps.config.skillsDir));
  deps.log.info(
    procedures.length === 0
      ? `Skills: ${deps.config.skillsDir} — none yet, and the coworker is told so. There are ` +
          "starter Skills in assets/skills (a README explaining the rules, and a worked " +
          "read-only database example) to copy there."
      : `Skills: ${deps.config.skillsDir} — ${procedures.length}, read-only to the coworker: ` +
          procedures.map((skill) => skill.path).join(", "),
  );

  for (const concern of await credentialConcerns(deps.config.skillsDir)) deps.log.warn(concern);
}
