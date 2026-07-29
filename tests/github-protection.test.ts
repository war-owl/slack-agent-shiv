import { describe, expect, it, vi } from "vitest";
import { createGitHubRepositoryProtectionProbe } from "../src/github/protection.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub repository protection", () => {
  it("checks effective default-branch rules and whether their rulesets can be bypassed", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ default_branch: "main" }))
      .mockResolvedValueOnce(
        json([
          {
            type: "pull_request",
            ruleset_id: 41,
            parameters: { required_approving_review_count: 1 },
          },
        ]),
      )
      .mockResolvedValueOnce(json({ current_user_can_bypass: "never" }));
    const probe = createGitHubRepositoryProtectionProbe({
      token: "github-token",
      request,
    });

    await expect(probe.check("acme/payments")).resolves.toEqual({
      status: "protected",
      defaultBranch: "main",
    });

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/acme/payments",
      "https://api.github.com/repos/acme/payments/rules/branches/main",
      "https://api.github.com/repos/acme/payments/rulesets/41",
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer github-token" }),
    });
  });

  it("distinguishes plan-gated protection from an ordinary GitHub failure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ default_branch: "main" }))
      .mockResolvedValueOnce(
        json(
          {
            message:
              "Upgrade to GitHub Pro or make this repository public to enable this feature.",
          },
          403,
        ),
      );
    const probe = createGitHubRepositoryProtectionProbe({
      token: "github-token",
      request,
    });

    await expect(probe.check("acme/private-repo")).resolves.toEqual({
      status: "unprotectable",
      defaultBranch: "main",
      reason: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    });
  });

  it("reports each missing protection requirement", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ default_branch: "trunk" }))
      .mockResolvedValueOnce(
        json([
          {
            type: "pull_request",
            ruleset_id: 9,
            parameters: { required_approving_review_count: 0 },
          },
        ]),
      )
      .mockResolvedValueOnce(json({ current_user_can_bypass: "always" }));
    const probe = createGitHubRepositoryProtectionProbe({
      token: "github-token",
      request,
    });

    await expect(probe.check("acme/payments")).resolves.toEqual({
      status: "unprotected",
      defaultBranch: "trunk",
      missing: [
        "an approving review",
        "administrator bypass disabled",
      ],
    });
  });

  it("does not disguise an ordinary authorization failure as plan gating", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ default_branch: "main" }))
      .mockResolvedValueOnce(json({ message: "Resource not accessible by token" }, 403));
    const probe = createGitHubRepositoryProtectionProbe({
      token: "github-token",
      request,
    });

    await expect(probe.check("acme/payments")).rejects.toThrow(
      "Resource not accessible by token",
    );
  });

  it("also recognises plan gating while reading a contributing ruleset", async () => {
    const reason = "Upgrade to GitHub Pro or make this repository public";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ default_branch: "main" }))
      .mockResolvedValueOnce(
        json([
          {
            type: "pull_request",
            ruleset_id: 9,
            parameters: { required_approving_review_count: 1 },
          },
        ]),
      )
      .mockResolvedValueOnce(json({ message: reason }, 403));
    const probe = createGitHubRepositoryProtectionProbe({
      token: "github-token",
      request,
    });

    await expect(probe.check("acme/private-repo")).resolves.toEqual({
      status: "unprotectable",
      defaultBranch: "main",
      reason,
    });
  });

  it("checks bypass state on every effective pull-request ruleset", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ default_branch: "main" }))
      .mockResolvedValueOnce(
        json([
          {
            type: "pull_request",
            ruleset_id: 9,
            parameters: { required_approving_review_count: 1 },
          },
          {
            type: "pull_request",
            ruleset_id: 10,
            parameters: { required_approving_review_count: 1 },
          },
        ]),
      )
      .mockResolvedValueOnce(json({ current_user_can_bypass: "never" }))
      .mockResolvedValueOnce(json({ current_user_can_bypass: "always" }));
    const probe = createGitHubRepositoryProtectionProbe({
      token: "github-token",
      request,
    });

    await expect(probe.check("acme/payments")).resolves.toEqual({
      status: "unprotected",
      defaultBranch: "main",
      missing: ["administrator bypass disabled"],
    });
  });
});
