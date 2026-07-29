import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { reasonFor } from "../failure.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../ports/log.ts";
import {
  credentialConcerns,
  proceduresIn,
  readSkills,
  skillsLocationProblems,
} from "../vault/skills.ts";

/**
 * The Skills location, and whether it can keep the one promise it makes.
 *
 * **The location check throws.** Everything else in preflight either describes an instance
 * that will work or refuses one whose action boundary is wrong. A Skills directory the
 * engine can write to is the second kind wearing the first kind's clothes: the instance runs
 * perfectly, the documentation says Skills are human-authored, and they are not. ADR-0004's
 * amendment is the only thing standing between a poisoned Job and a command running in a
 * different Thread with a different audience, and it is enforced by nothing except this
 * directory being off the writable list — so an arrangement that voids it must not start.
 *
 * Checked here rather than discovered on first use because build/15 made it a structural
 * guarantee, and a guarantee worth having is worth verifying before a Job depends on it.
 *
 * The credential scan only warns. That asymmetry is argued in `vault/skills.ts`: one is
 * the project failing to deliver its own guarantee, the other is the self-hoster's
 * credential in the self-hoster's vault.
 */
export async function checkSkills(deps: { config: Config; log: Logger }): Promise<void> {
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

  await checkSkillsAreReadable(deps);

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

/**
 * That the directory is there and can be read, before a Job depends on it.
 *
 * `readSkills` treats an unreadable directory as an empty one, deliberately: an absent Skills
 * directory is the ordinary starting state and a Job should not fail because nobody has
 * written a procedure yet. But that same leniency makes a **mistyped path** indistinguishable
 * from a clean install — "no Skills yet" for a directory full of them — which is exactly the
 * kind of thing this criterion means by "checked at startup rather than discovered on first
 * use".
 *
 * So the two cases are separated. Absent is a warning naming the path, because the honest
 * reading is "nothing will be read from here, and if you meant somewhere else, this is the
 * typo". Present but unreadable is fatal: the layout checks above have just certified an
 * arrangement whose whole purpose is that the coworker can *read* these and not write them,
 * and half of that is not true.
 */
async function checkSkillsAreReadable(deps: { config: Config; log: Logger }): Promise<void> {
  const skillsDir = deps.config.skillsDir;
  let directory: boolean;
  try {
    directory = (await stat(skillsDir)).isDirectory();
  } catch {
    deps.log.warn(
      `There is no Skills directory at ${skillsDir}, so the coworker is told it has no ` +
        "procedures. That is the ordinary starting state — but if you meant a directory that " +
        "does exist, this is where the path is wrong. See docs/configuration.md.",
    );
    return;
  }

  if (!directory) {
    throw new Error(
      `${skillsDir} is a file rather than a directory, so the Skills location is not a ` +
        "location. Point `vault.skills` at the directory holding your procedures.",
    );
  }

  try {
    await access(skillsDir, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw new Error(
      `The Skills directory at ${skillsDir} cannot be read: ${reasonFor(error)}. The whole ` +
        "arrangement is that the coworker reads these and cannot write them, and an instance " +
        "that can do neither would start, report no Skills, and quietly ignore every " +
        "procedure in there.",
    );
  }
}
