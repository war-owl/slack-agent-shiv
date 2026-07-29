/**
 * GitHub, which is deliberately not a connector.
 *
 * [ADR-0006](../../docs/adr/0006-github-is-a-skill-over-gh.md) took GitHub out of the MCP
 * tool path and made it a Skill over the `gh` CLI, authenticated by a **GitHub App
 * installation** whose repository list the self-hoster picks in GitHub's own UI. So there is
 * no tool inventory to pin and no deny-list to generate; what there is instead is an
 * installation, and the questions preflight asks about it are entirely different ones:
 * does the credential work, what does it reach, and what may it do.
 *
 * Two things this port is careful *not* to do:
 *
 * - **It never hands back a token.** Preflight's job is to prove one can be minted, and a
 *   token that outlived that proof would be a token sitting in the wrapper's memory for the
 *   life of the process. Minting for actual work is the credential helper's (build/09), on
 *   demand, outside the sandbox's writable root.
 * - **It answers no questions about branch protection.** That is layer 3 and it belongs to
 *   [build/10](../../.scratch/slack-coworker/build/10-branch-protection-verification.md),
 *   which warns rather than refuses and needs a repository-by-repository shape this does
 *   not have.
 */

/** The App's own credentials — the private key GitHub gave you, and the App's id. */
export interface GitHubAppCredentials {
  appId: string;
  /** The PEM contents, read from the `.pem` file GitHub downloaded. Never logged. */
  privateKeyPem: string;
}

/**
 * What one installation of the App can reach.
 *
 * `repositories` is the answer to the question the self-hoster thinks they answered in
 * GitHub's repository picker — which is exactly why preflight reports it rather than
 * trusting it. Picking repositories in a web UI and naming them in a config file are two
 * separate acts, and the likeliest setup mistake on this path is that they disagree.
 */
export interface GitHubInstallation {
  id: number;
  /** The organisation or user the App is installed on. */
  account: string;
  /**
   * Whether the repository picker was used, in GitHub's own words — and `unknown` for the
   * third case, which is GitHub answering something this project has not seen. Named rather
   * than left as a bare string because two checks branch on it, and a typo in either would be
   * a boundary quietly not applying.
   */
  repositorySelection: "all" | "selected" | "unknown";
  /** `owner/name`, as the installation itself reports them. */
  repositories: string[];
  /**
   * The permissions the App declares, as GitHub reports them for this installation —
   * `{ contents: "write", pull_requests: "write", … }`.
   *
   * Read from the installation rather than from the manifest the project ships, because the
   * manifest is what was *asked for* and this is what was *granted*. An installer who
   * accepted an older permission set is a real state, and the whole point of reporting it
   * is that the two can differ.
   */
  permissions: Record<string, string>;
}

/** The App, its installation, and proof that a token can actually be had. */
export interface GitHubAppReach {
  /** The App's slug, so the startup line names the App a human can go and look at. */
  appSlug: string;
  installation: GitHubInstallation;
  /**
   * When the installation token minted during preflight expires — the one fact worth
   * keeping from a credential that is otherwise thrown away.
   *
   * Its presence *is* the check: ADR-0006 rests on tokens being derived at runtime, so
   * validating the private key alone would prove the wrong half.
   */
  tokenExpiresAt: string;
}

export interface GitHubAppProbe {
  /**
   * Resolve the installation and mint a throwaway token against it.
   *
   * `owner` narrows the choice when the App is installed in more than one place. Left out
   * with several installations present, this must fail rather than pick: which account the
   * coworker acts on is not a detail to guess at.
   */
  probe(options: { owner?: string | undefined }): Promise<GitHubAppReach>;
}

/**
 * The `gh` binary, as a version.
 *
 * A CLI dependency is a version that drifts the way Codex's does — GitHub capability now
 * lives in a program somebody else upgrades — so it gets the same treatment: report what is
 * installed, warn when it is not what this project was built against. `undefined` means
 * there is no `gh` on `PATH` at all, which is fatal for an instance configured to use
 * GitHub and irrelevant for one that is not.
 */
export interface GitHubCli {
  version(): Promise<string | undefined>;
}
