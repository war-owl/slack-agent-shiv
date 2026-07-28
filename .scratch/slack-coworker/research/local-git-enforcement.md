# Local git enforcement: what a pre-push hook does and does not buy

Measured 2026-07-28 against local bare remotes (no network, no GitHub involvement). Prompted by [Check B](../issues/05-provision-accounts-and-tokens.md#answer--checks-a-and-b) finding that GitHub-side protection is plan-gated on free private repositories, which leaves [ADR-0002](../../../docs/adr/0002-unattended-action-boundary.md)'s layer 3 unavailable for plausibly the modal self-hoster.

## The question

Can a repo-managed pre-push hook (`git config core.hooksPath .githooks`) substitute for branch protection where branch protection cannot be switched on?

## Finding 1 — the obvious hook implementation does not work

The natural implementation checks the **current branch** and greps the parent process command line for `--force`:

```bash
current_branch="$(git rev-parse --abbrev-ref HEAD)"
push_cmd="$(ps -ocommand= -p "$PPID" || true)"
[[ "$current_branch" =~ ^(main|master)$ ]] && exit 1
[[ "$push_cmd" =~ (--force|--force-with-lease|-f) ]] && exit 1
```

Both tests are wrong, and both were defeated on the first attempt:

| Attack | Result |
|---|---|
| `git push origin HEAD:main` from a feature branch | **pushed to main.** `current_branch` is the feature branch; the hook never inspects the destination. |
| `git push origin "+HEAD:refs/heads/x"` (true non-fast-forward) | **rewrote remote history.** The `+` refspec forces without the literal `--force` string, so the `ps` grep matches nothing. |

Command-line inspection is unsound generally: it also misses pushes issued by a library rather than the `git` binary, and `$PPID` is not reliably the invoking `git`.

## Finding 2 — the correct implementation is stdin-driven

Git hands `pre-push` one line per ref on stdin: `<local ref> <local oid> <remote ref> <remote oid>`. Judging the **destination ref** and real ancestry is flag-independent and refspec-independent.

```bash
#!/usr/bin/env bash
set -uo pipefail
protected='^refs/heads/(main|master)$'
status=0
while read -r local_ref local_oid remote_ref remote_oid; do
  [ -z "${remote_ref:-}" ] && continue
  if [[ "$remote_ref" =~ $protected ]]; then
    echo "blocked: push to protected ref '$remote_ref'"; status=1; continue
  fi
  if [[ "$local_oid" =~ ^0+$ ]]; then
    echo "blocked: deletion of remote ref '$remote_ref'"; status=1; continue
  fi
  [[ "$remote_oid" =~ ^0+$ ]] && continue   # new branch, nothing to rewrite
  if ! git merge-base --is-ancestor "$remote_oid" "$local_oid"; then
    echo "blocked: non-fast-forward push to '$remote_ref'"; status=1
  fi
done
exit $status
```

Zero-OID is matched as `^0+$` rather than a 40-character literal so it holds under SHA-256 repositories. Verified matrix:

| Case | Result |
|---|---|
| `push origin HEAD:main` from a feature branch | blocked (protected ref) |
| true non-fast-forward via `+` refspec | blocked (ancestry) |
| remote branch deletion | blocked |
| ordinary fast-forward to a new feature branch | **allowed** |
| `push --no-verify` to main | **BYPASSED** |

## Finding 3 — it is not a boundary, and must not be recorded as one

The last row is not a defect to fix; it is inherent. `--no-verify` skips `pre-push` unconditionally. Three further exits exist for an agent in this project's configuration:

- the sandbox is `workspace-write`, so the agent **can edit `.githooks/pre-push`**;
- `git -c core.hooksPath=/dev/null push …` bypasses per invocation;
- the PAT is in the agent's environment, so `curl -X PUT …/pulls/N/merge` never touches git at all.

ADR-0002 is written for the adversarial case — "no human between a crafted issue comment and an action". Against that threat model a local hook contributes nothing, because every bypass above is available to a prompt-injected agent with shell access.

**Therefore: record the hook inside layer 2 as defence-in-depth alongside the deny-list, not as a replacement for layer 3.** It guards against accident, model error, and configuration drift — real failure modes, and the common ones — but describing it as making the agent "technically incapable" would put a false claim in the one document that has to be honest about residual risk.

## What it is genuinely worth

Three things GitHub-side protection does not cover:

1. **Free-plan private repositories**, where per Check B no server-side mechanism is available at all. This is the strongest case for shipping it.
2. **Non-default branches** — the ruleset targets `~DEFAULT_BRANCH`; the hook can protect any pattern.
3. **Repositories the self-hoster does not administer**, where they cannot set a ruleset even on a paid plan.

## Open questions this raises

- **Does `execpolicy` reopen?** ADR-0002 sets it unrestricted, reasoning that "per-command rules cost more tuning than they buy once the repository is the boundary." On a free private repo the repository is *not* the boundary, so that rationale lapses for exactly the case that needs it most. Restricting `git push` at the sandbox is harder to bypass than a hook — the agent cannot edit the sandbox policy from inside the sandbox — though `curl` remains open. Not decided here.
- **Where does the hook get installed?** `core.hooksPath` is repository-local config, so the wrapper must set it on every checkout it creates ([build/12](../build/12-git-checkout-and-pull-request.md)), not once at setup.
- **Does the wrapper verify the hook survived?** If the agent can edit it, preflight or the checkout step should re-assert it rather than trust it.
