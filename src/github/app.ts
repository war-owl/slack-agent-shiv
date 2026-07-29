import { createSign } from "node:crypto";
import type { Clock } from "../ports/clock.ts";
import type { GitHubAppCredentials, GitHubAppProbe, GitHubAppReach } from "../ports/github.ts";

/**
 * The GitHub App, as preflight needs to know it: sign a JWT, find the installation, mint a
 * token, and read what that token reaches.
 *
 * **Deliberately not a GitHub client.** Nothing else in this codebase talks to GitHub's API
 * — the coworker runs `gh` (ADR-0006) — so this module has exactly one caller and exactly
 * one job. Adding an issue-reading function here would be re-creating, in the wrapper, the
 * tool path that ADR took out.
 *
 * The token minted here is used to answer one question (which repositories) and then
 * dropped. Tokens for work are the credential helper's, minted per use, so that a Job never
 * holds one and there is no hour-long expiry to straddle.
 */

const API = "https://api.github.com";

/** GitHub allows up to 10 minutes on an App JWT; this is well inside it and inside clock skew. */
const JWT_LIFETIME_SECONDS = 9 * 60;

/**
 * A minute of backdating, which GitHub's own documentation recommends.
 *
 * The failure it prevents is a horrible one to debug: a machine whose clock is a few seconds
 * fast gets `401 'Issued at' claim ('iat') must be an integer representing the time in the
 * past`, which reads as a bad key rather than a bad clock.
 */
const JWT_BACKDATE_SECONDS = 60;

export function createGitHubAppProbe(deps: {
  credentials: GitHubAppCredentials;
  clock: Clock;
}): GitHubAppProbe {
  return {
    async probe(options: { owner?: string | undefined }): Promise<GitHubAppReach> {
      const jwt = appJwt(deps.credentials, deps.clock);

      // `GET /app` first, because it is the one call that fails *only* on the credential.
      // Getting a clear "this key is not this App's" before anything about installations is
      // what makes the next failure legible.
      const app = await api<{ slug?: string }>(jwt, "/app");
      const installation = await resolveInstallation(jwt, options.owner);
      const minted = await mint(jwt, installation.id);

      return {
        appSlug: app.slug ?? "(unnamed)",
        installation: {
          id: installation.id,
          account: installation.account?.login ?? "(unknown account)",
          repositorySelection: selectionOf(installation.repository_selection),
          // Read with the installation token rather than from the installation record,
          // because the record does not carry them: what the App was granted is a question
          // only the derived credential can answer, which is the same reason the token is
          // minted here at all.
          repositories: await repositoriesOf(minted.token),
          permissions: minted.permissions ?? installation.permissions ?? {},
        },
        tokenExpiresAt: minted.expires_at ?? "(no expiry reported)",
      };
    },
  };
}

/**
 * An App that was never configured, and refuses to be asked.
 *
 * It throws rather than answering benignly, because a probe that reported "fine" for an App
 * that does not exist would be the one lie in this path. Preflight skips GitHub entirely when
 * it is unconfigured, so this is unreachable in practice — it exists so that "not configured"
 * has exactly one representation, in `config.github`, rather than a second one at the wiring.
 */
export const unconfiguredGitHubApp: GitHubAppProbe = {
  probe(): Promise<GitHubAppReach> {
    throw new Error("GitHub is not configured, so there is no App to probe");
  },
};

/** GitHub's `repository_selection`, narrowed — anything else is reported as unknown. */
function selectionOf(value: string | undefined): "all" | "selected" | "unknown" {
  return value === "all" || value === "selected" ? value : "unknown";
}

interface InstallationRecord {
  id: number;
  account?: { login?: string } | null;
  repository_selection?: string;
  permissions?: Record<string, string>;
}

/**
 * Which installation this instance acts as.
 *
 * One installation and no configured owner is the common case and needs no ceremony. Several
 * and no owner **must not be guessed**: which organisation the coworker acts on is the
 * difference between two audiences, and picking the first would be picking one for reasons
 * that are alphabetical.
 */
async function resolveInstallation(
  jwt: string,
  owner: string | undefined,
): Promise<InstallationRecord> {
  const installations = await api<InstallationRecord[]>(jwt, "/app/installations?per_page=100");

  if (installations.length === 0) {
    throw new Error(
      "the App exists but is not installed anywhere. Install it from its public page or its " +
        "settings, and pick the repositories the coworker should reach",
    );
  }

  if (owner !== undefined) {
    const wanted = installations.find(
      (candidate) => candidate.account?.login?.toLowerCase() === owner.toLowerCase(),
    );
    if (wanted === undefined) {
      throw new Error(
        `the App is not installed on "${owner}". It is installed on: ` +
          `${installations.map((one) => one.account?.login ?? `installation ${one.id}`).join(", ")}`,
      );
    }
    return wanted;
  }

  const [only] = installations;
  if (installations.length > 1 || only === undefined) {
    throw new Error(
      "the App is installed in more than one place and configuration does not say which to " +
        `use: ${installations.map((one) => one.account?.login ?? `installation ${one.id}`).join(", ")}. ` +
        'Add `"owner"` to the configuration file\'s `github` section',
    );
  }
  return only;
}

interface MintedToken {
  token: string;
  expires_at?: string;
  permissions?: Record<string, string>;
}

function mint(jwt: string, installationId: number): Promise<MintedToken> {
  return api<MintedToken>(jwt, `/app/installations/${installationId}/access_tokens`, "POST");
}

/**
 * Every repository the installation grants, as `owner/name`.
 *
 * Paginated properly rather than taking the first hundred: an installation on "all
 * repositories" of a busy organisation runs to several pages, and a truncated list here
 * would understate the coworker's reach in the one report whose whole purpose is to state it.
 */
async function repositoriesOf(token: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const listed = await api<{ repositories?: { full_name?: string }[] }>(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
    );
    const repositories = listed.repositories ?? [];
    for (const repository of repositories) {
      if (repository.full_name !== undefined) names.push(repository.full_name);
    }
    if (repositories.length < 100) break;
  }
  return names;
}

/**
 * The App's own JWT: RS256 over `{iat, exp, iss}`, signed with the private key.
 *
 * Hand-rolled rather than pulled from a library, and that is a considered choice: this is
 * three base64url segments and one `createSign` call, against a dependency in the path of the
 * project's most sensitive credential. `node:crypto` reads the PEM GitHub downloads directly.
 */
function appJwt(credentials: GitHubAppCredentials, clock: Clock): string {
  const now = Math.floor(clock.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - JWT_BACKDATE_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: credentials.appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  let signature: string;
  try {
    signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(credentials.privateKeyPem, "base64url");
  } catch (error) {
    // The message is deliberately about the *file* rather than the key: nothing about a
    // private key's contents belongs in a log, and "which file" is the actionable half.
    throw new Error(
      "the private key could not sign a token. GitHub's download is a PKCS#1 PEM; a key that " +
        "has been re-encoded, truncated, or pasted through a chat client fails exactly here. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return `${signingInput}.${signature}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * One GitHub API call, with the errors GitHub actually returns turned into sentences.
 *
 * `Accept: application/vnd.github+json` and a pinned `X-GitHub-Api-Version`, because an
 * unversioned client against a REST API that versions by header is a client that changes
 * behaviour without a deploy.
 */
async function api<T>(credential: string, endpoint: string, method = "GET"): Promise<T> {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-agent-preflight",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${method} ${endpoint} answered ${response.status}. ${reasonFrom(body)}`);
  }
  return (await response.json()) as T;
}

/**
 * GitHub's own message, when it sent one.
 *
 * Worth extracting rather than dumping the body, because GitHub's messages are unusually
 * good and unusually specific — "Integration must be installed on this repository", "A JSON
 * web token could not be decoded" — and each names its own remedy.
 */
function reasonFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON. Fall through to the raw body, clipped.
  }
  const trimmed = body.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
