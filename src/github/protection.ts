import type {
  BranchProtection,
  RepositoryProtectionProbe,
} from "../ports/repositories.ts";
import { parseRepositoryName } from "../repositories/name.ts";

interface GitHubProtectionOptions {
  token: string;
  request?: typeof fetch;
}

interface EffectiveRule {
  type?: unknown;
  ruleset_id?: unknown;
  parameters?: {
    required_approving_review_count?: unknown;
  };
}

/** Reads the effective default-branch rules rather than guessing which GitHub mechanism owns them. */
export function createGitHubRepositoryProtectionProbe(
  options: GitHubProtectionOptions,
): RepositoryProtectionProbe {
  const request = options.request ?? fetch;
  const get = async (path: string): Promise<Response> =>
    request(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

  return {
    async check(repository: string): Promise<BranchProtection> {
      const parsed = parseRepositoryName(repository);
      const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
      const metadata = await githubJson(get, base);
      const defaultBranch = requiredString(metadata, "default_branch", repository);
      try {
        const rules = await githubJson(
          get,
          `${base}/rules/branches/${encodeURIComponent(defaultBranch)}`,
        );
        if (!Array.isArray(rules)) {
          throw new Error(`GitHub returned invalid effective rules for ${repository}`);
        }

        const pullRequests = (rules as EffectiveRule[]).filter(
          (rule) => rule.type === "pull_request",
        );
        const rulesetIds = [
          ...new Set(
            pullRequests
              .map((rule) => rule.ruleset_id)
              .filter((id): id is number => typeof id === "number"),
          ),
        ];
        const bypass = await Promise.all(
          rulesetIds.map(async (id) => {
            const detail = await githubJson(get, `${base}/rulesets/${id}`);
            return requiredString(detail, "current_user_can_bypass", repository);
          }),
        );
        const hasReview = pullRequests.some((rule) => {
          const count = rule.parameters?.required_approving_review_count;
          return typeof count === "number" && count >= 1;
        });
        const unresolvedRuleset = pullRequests.some(
          (rule) => typeof rule.ruleset_id !== "number",
        );
        const missing = [
          ...(pullRequests.length === 0 ? ["pull requests required before merging"] : []),
          ...(!hasReview ? ["an approving review"] : []),
          ...(rulesetIds.length === 0 ||
          unresolvedRuleset ||
          bypass.some((value) => value !== "never")
            ? ["administrator bypass disabled"]
            : []),
        ];

        return missing.length === 0
          ? { status: "protected" as const, defaultBranch }
          : { status: "unprotected" as const, defaultBranch, missing };
      } catch (error) {
        if (error instanceof GitHubHttpError && error.planRestricted) {
          return {
            status: "unprotectable",
            defaultBranch,
            reason: error.message,
          };
        }
        throw error;
      }
    },
  };
}

async function githubJson(
  get: (path: string) => Promise<Response>,
  path: string,
): Promise<unknown> {
  const response = await get(path);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : `${response.status} ${response.statusText}`;
    throw new GitHubHttpError(response.status, message);
  }
  return body;
}

class GitHubHttpError extends Error {
  readonly planRestricted: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubHttpError";
    this.planRestricted =
      status === 403 &&
      /upgrade to github pro|make this repository public/i.test(message);
  }
}

function requiredString(body: unknown, field: string, repository: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    field in body &&
    typeof body[field as keyof typeof body] === "string"
  ) {
    return body[field as keyof typeof body] as string;
  }
  throw new Error(`GitHub omitted ${field} while checking ${repository}`);
}
