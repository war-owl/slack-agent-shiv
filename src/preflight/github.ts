import { RECORDED_GH_VERSION, type Config } from "../config.ts";
import { reasonFor } from "../failure.ts";
import type { GitHubAppProbe, GitHubAppReach, GitHubCli } from "../ports/github.ts";
import type { Logger } from "../ports/log.ts";

/**
 * The GitHub half of preflight — **an installation, not an inventory**.
 *
 * [ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md) made GitHub a Skill over the
 * `gh` CLI, which changes the shape of every question here. There is no `tools/list` to pin
 * and no `disabled_tools` to generate; there is a credential that must be derivable, an
 * installation whose reach must be visible, and a permission set that must not contain
 * three specific things. Do not try to unify this with `connectors.ts` — the asymmetry is
 * the decision, and an abstraction over both would have to pretend GitHub has a tool
 * surface.
 *
 * It **starts** by saying what is missing, which is the unusual part: an instance with GitHub
 * configured runs without layer 2 entirely. First rather than last, and that ordering is the
 * whole reason it is where it is — every check below this can throw, and a statement printed
 * after them is a statement a self-hoster with a misconfigured App never sees.
 */

/**
 * App permissions this project's manifest must never carry.
 *
 * The App-manifest equivalents of the PAT scopes ADR-0002 withheld, and each is an execution
 * path around every other control: `administration` can delete a repository or turn branch
 * protection off, `members` can change who else has access, and `workflows` can rewrite a CI
 * definition into anything at all — layer 3 is worth nothing to an installation that can edit
 * the rules or the pipeline that enforces them.
 *
 * Checked at startup because they are granted in GitHub's UI by whoever installed the App,
 * which is not necessarily whoever wrote the manifest.
 */
const FORBIDDEN_APP_PERMISSIONS: readonly string[] = ["administration", "members", "workflows"];
export async function checkGitHub(deps: {
  config: Config;
  github: GitHubAppProbe;
  gh: GitHubCli;
  log: Logger;
}): Promise<void> {
  const app = deps.config.github;
  if (app === undefined) {
    deps.log.info(
      "GitHub: not configured. No App, no credential, and the `gh` Skill will not work — " +
        "which is a legitimate way to run this.",
    );
    return;
  }

  // Before anything that can throw. Read together with build/10's branch-protection warning
  // — which prints from the same startup — these are the two halves of the weakened
  // boundary, and seeing only one of them is how an operator concludes the other does not
  // apply to them.
  deps.log.warn(
    "GitHub has no layer-2 deny-list. It is reached by Skill over the `gh` CLI rather than " +
      "over MCP, so there is no tool surface to disable and no inventory to pin: nothing " +
      "structurally prevents this instance from merging a pull request or deleting a file. " +
      "What stands in its place is the Skill's own instruction, the `AGENTS.md` git policy, " +
      "the pre-push hook, and branch protection on the default branch — every one of which " +
      "is weaker than a tool that does not exist. See ADR-0006.",
  );

  await checkGhVersion(deps);

  // Everything below rests on this call succeeding, and it is deliberately the *whole*
  // credential path rather than a signature check: sign a JWT, resolve the installation,
  // and actually mint an installation token. Validating the private key alone would prove
  // the half that never expires and skip the half that does.
  let reach: GitHubAppReach;
  try {
    reach = await deps.github.probe({ owner: app.owner });
  } catch (error) {
    throw new Error(
      `The GitHub App could not be used, so the instance is stopping: ${reasonFor(error)}\n\n` +
        `App id ${app.appId} (from configuration), private key ${app.privateKeyPath}. If the ` +
        "App exists but has never been installed, install it and pick its repositories; if " +
        "it is installed on an organisation, an owner may still have to approve it. An " +
        "unapproved installation fails here rather than degrading to public-only reads, " +
        "which is the point.",
    );
  }

  deps.log.info(
    `GitHub: App ${reach.appSlug} (id ${app.appId}), installed on ${reach.installation.account} ` +
      `as installation ${reach.installation.id}. Test token minted, expiring ` +
      `${reach.tokenExpiresAt} — tokens are minted per use, so there is nothing to rotate.`,
  );

  reportReach(deps.log, reach);
  requireConfiguredRepositories(app.repositories, reach);
  requirePermissions(deps.log, reach);
}

/**
 * The `gh` version, against the recorded one.
 *
 * Absent is fatal and different is a warning, and the asymmetry is the point: an instance
 * configured for GitHub with no `gh` on `PATH` cannot do the thing it was configured to do,
 * and would discover that inside a Job as a shell command that failed for reasons the
 * coworker would then try to work around.
 */
async function checkGhVersion(deps: { gh: GitHubCli; log: Logger }): Promise<void> {
  const version = await deps.gh.version();
  if (version === undefined) {
    throw new Error(
      "GitHub is configured but there is no `gh` on PATH. Since ADR-0006 the coworker " +
        "reaches GitHub by running `gh`, so this is a missing dependency rather than a " +
        "missing convenience: install it (https://cli.github.com), or remove `github` from " +
        "the configuration file.",
    );
  }

  deps.log.info(`gh version ${version} (recorded: ${RECORDED_GH_VERSION})`);
  if (version !== RECORDED_GH_VERSION) {
    deps.log.warn(
      `The installed gh is ${version}, but this project's Skills were written against ` +
        `${RECORDED_GH_VERSION}. There is no pin, so the instance will run anyway — but a ` +
        "Skill that issues a flag this version removed fails inside a Job, unattended.",
    );
  }
}

/**
 * What the installation actually reaches, reported rather than assumed.
 *
 * The repository list is the coworker's real blast radius on GitHub, and it was chosen in a
 * web UI at some point in the past by somebody who may not be reading this. Printing it
 * every startup is the cheapest possible way for "it can see more than I thought" to be
 * noticed by the person who can fix it.
 */
function reportReach(log: Logger, reach: GitHubAppReach): void {
  const { repositories, repositorySelection } = reach.installation;

  if (repositories.length === 0) {
    log.warn(
      "The GitHub App's installation grants no repositories at all. Every GitHub Job will " +
        "fail: open the installation and pick some.",
    );
    return;
  }

  // Named in every case, including "all" — *especially* including "all", which is the widest
  // reach an instance can have and therefore the one worth reading. A count alone would make
  // the report least informative exactly where it matters most.
  log.info(
    `GitHub reach: ${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"} ` +
      `— ${repositories.join(", ")}`,
  );

  if (repositorySelection === "all") {
    log.warn(
      `The GitHub App is installed on **all** of ${reach.installation.account}'s ` +
        "repositories, so any repository added to that account later is in the coworker's " +
        "reach without anybody deciding so. Repository selection is the one boundary this " +
        "design does have — narrow the installation to the repositories it needs.",
    );
  }
}

/**
 * Configuration says which repositories this instance expects; the installation says which
 * it has. A name in the first and not the second stops startup.
 *
 * The likeliest setup mistake on this path, and its natural failure is bad: a Job told to
 * open a pull request in a repository the installation does not grant fails deep inside a
 * `gh` invocation, in a Thread, with a 404 that reads like the repository not existing.
 *
 * Checked against an `all` installation too. It would be easy to skip — "all" surely covers
 * anything named — and wrong: the list came back from the installation moments ago, so a name
 * missing from it is a repository that does not exist, is spelled differently, or belongs to
 * a different account, and each of those is the same typo this check exists to catch.
 */
function requireConfiguredRepositories(
  configured: readonly string[],
  reach: GitHubAppReach,
): void {
  if (configured.length === 0) return;

  const granted = new Set(reach.installation.repositories.map((name) => name.toLowerCase()));
  const missing = configured.filter((name) => !granted.has(name.toLowerCase()));
  if (missing.length === 0) return;

  throw new Error(
    "The configuration file names repositories the GitHub App installation does not grant, " +
      "so the instance is stopping rather than failing inside a Job:\n" +
      missing.map((name) => `  - ${name}`).join("\n") +
      "\n\nThe installation on " +
      `${reach.installation.account} grants:\n` +
      reach.installation.repositories.map((name) => `  - ${name}`).join("\n") +
      "\n\nEither the picker in GitHub's UI and the configuration file disagree, or the name " +
      "is misspelled. Fix whichever is wrong — the installation is the ceiling and nothing " +
      "in this instance can widen it.",
  );
}

/**
 * The declared permissions, reported — and the three that must not be there, refused.
 *
 * Reported because "what may it do" should not require reading a manifest in a repository;
 * refused because {@link FORBIDDEN_APP_PERMISSIONS} are each a way around the rest of the
 * design, and an installation carrying one is not the installation this project describes.
 */
function requirePermissions(log: Logger, reach: GitHubAppReach): void {
  const permissions = reach.installation.permissions;
  const granted = Object.entries(permissions)
    .map(([name, level]) => `${name}: ${level}`)
    .sort();
  log.info(
    granted.length === 0
      ? "The GitHub App declares no permissions, which cannot be right — it will not be able " +
          "to read a repository."
      : `GitHub App permissions: ${granted.join(", ")}`,
  );

  const forbidden = FORBIDDEN_APP_PERMISSIONS.filter((name) => name in permissions);
  if (forbidden.length === 0) return;

  throw new Error(
    "The GitHub App carries permissions this project's manifest must never declare, so the " +
      "instance is stopping:\n" +
      forbidden.map((name) => `  - ${name}: ${permissions[name]}`).join("\n") +
      "\n\nEach is a route around every other control — `administration` can turn branch " +
      "protection off, `members` can change who has access, and `workflows` can rewrite CI " +
      "into anything at all. Remove them from the App's permissions in GitHub's settings; " +
      "the installer will be asked to accept the smaller set.",
  );
}
