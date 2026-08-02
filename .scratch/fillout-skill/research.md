# Fillout REST API skill viability

Research date: 2026-07-31

## Conclusion

A local Fillout integration is technically straightforward and useful. Fillout's documented REST API is small, uses ordinary JSON over HTTPS, and covers the core local-agent workflows: discover forms, inspect their fields, search and page through submissions, fetch one submission, import submissions, delete a submission, and create or remove submission webhooks. Authentication is a bearer token, and the usual base URL is `https://api.fillout.com/v1/api`. Fillout says self-hosted and EU deployments may use a different dashboard-provided base URL. ([API overview](https://www.fillout.com/help/fillout-rest-api))

The best first version is a **read-oriented skill backed by a small allowlisted helper**, not instructions that teach the agent to construct arbitrary `curl` requests. It should expose form discovery, metadata lookup, submission listing/search/pagination, and single-submission retrieval. Write operations should be omitted initially or placed behind distinct, intentionally invoked commands.

The important caveat is structural, not technical: Fillout documents a single account/API key and does not document endpoint-level scopes or a read-only key. That same bearer credential authenticates GET, POST, and DELETE endpoints. A helper can prevent accidental writes, but if the raw key is available to an agent with general shell/network access, an allowlist in the helper is not an enforceable security boundary. This repository's own skill model makes the same point: shell-backed skills bypass MCP tool policy, so "the credential is the entire boundary" ([project skill security model](../../docs/skills.md#the-security-model)). For strong read-only enforcement, put the Fillout key behind a local proxy or a tiny MCP server that only exposes approved GET operations; otherwise accept that the Fillout key grants the documented write/delete capabilities too.

## Authentication, hosts, and limits

- Requests use `Authorization: Bearer <api-key>`. The key is created, viewed, revoked, or regenerated in Fillout's Developer settings. The credential should live only in an environment variable or secret store, never in the skill Markdown, command history, logs, or repository. ([API overview](https://www.fillout.com/help/fillout-rest-api))
- The API dashboard is the authority for the base URL. Fillout says the typical host is `https://api.fillout.com`; its endpoint pages also show `https://eu-api.fillout.com/v1/api`, and the overview warns that EU-agent or self-hosted accounts may have a different URL. A helper should therefore require/configure `FILLOUT_API_BASE_URL` rather than hard-code the US host. ([API overview](https://www.fillout.com/help/fillout-rest-api), [get forms](https://www.fillout.com/help/api-reference/get-forms))
- All documented endpoints are limited to 5 calls per second per account/API key. A helper should throttle below that ceiling and retry `429`/transient failures with bounded backoff, although Fillout does not document retry headers or a retry algorithm on the overview page. ([API overview](https://www.fillout.com/help/fillout-rest-api))
- Fillout also mentions OAuth-style access tokens for third-party Fillout integrations, but an account API key is the simplest fit for a single-user local tool. ([API overview](https://www.fillout.com/help/fillout-rest-api), [third-party apps](https://www.fillout.com/help/oauth-applications))

## Documented API surface

| Risk | Operation | Endpoint | Practical use |
| --- | --- | --- | --- |
| Read | List forms | `GET /forms` | Returns every accessible form as `{name, formId}`. ([docs](https://www.fillout.com/help/api-reference/get-forms)) |
| Read | Get form metadata | `GET /forms/{formId}` | Returns form identity plus questions, calculations, URL parameters, scheduling, payment, and quiz metadata. ([docs](https://www.fillout.com/help/api-reference/get-form-metadata)) |
| Read | List submissions | `GET /forms/{formId}/submissions` | Returns response records plus `totalResponses` and `pageCount`; this is the main search/export surface. ([docs](https://www.fillout.com/help/api-reference/get-all-submissions)) |
| Read | Get one submission | `GET /forms/{formId}/submissions/{submissionId}` | Returns a single full submission. ([docs](https://www.fillout.com/help/api-reference/get-submission-by-id)) |
| Destructive | Delete one submission | `DELETE /forms/{formId}/submissions/{submissionId}` | Permanently changes remote data; the API reference only documents a success response, not a restore or soft-delete contract. ([docs](https://www.fillout.com/help/api-reference/delete-submission-by-id)) |
| Write | Create webhook | `POST /webhook/create` | Registers a URL for one form and returns a webhook ID. ([docs](https://www.fillout.com/help/api-reference/create-a-webhook)) |
| Destructive/configuration | Remove webhook | `POST /webhook/delete` | Removes a webhook by the ID returned at creation. ([docs](https://www.fillout.com/help/api-reference/remove-a-webhook)) |
| Write | Create submissions | `POST /forms/{formId}/submissions` | Imports up to 10 submissions per request and returns the created records. ([docs](https://www.fillout.com/help/api-reference/create-submissions)) |

The official REST API navigation lists these eight operations. It does **not document** REST operations for creating, modifying, publishing, or deleting forms; updating an existing submission directly; listing existing webhook registrations; restoring a deleted submission; or account/workspace administration. This is a statement about the published reference, not proof that undocumented private endpoints do not exist. ([API reference navigation](https://www.fillout.com/help/fillout-rest-api))

## Submission retrieval and pagination

`GET /forms/{formId}/submissions` supports:

- `limit`: default 50, allowed range 1–150.
- `offset`: default 0.
- `afterDate` and `beforeDate`: date-time bounds on submission time.
- `status`: `finished` (the default) or `in_progress`.
- `includeEditLink=true`: includes an `editLink` for each submission.
- `includePreview=true`: includes preview responses.
- `sort`: `asc` (default) or `desc`.
- `search`: filters submissions containing a text string.

The response includes `responses`, `totalResponses`, and `pageCount`. A helper can iterate with `offset += limit` until it has consumed `totalResponses` (or reached `pageCount`), while preserving all active filters. For large or changing datasets it should prefer a stable date window and explicitly chosen sort order, because the API documents offset pagination rather than a snapshot/cursor guarantee. ([get all submissions](https://www.fillout.com/help/api-reference/get-all-submissions))

Submission values are heterogeneous (`value` is documented as unknown), and responses can include calculations, URL parameters, scheduling details, payment details, quiz scores, and login email. Fillout explicitly warns that new field types are added regularly and clients should discard unknown field types. The helper should preserve raw JSON, avoid exhaustive type switches, and optionally flatten only known fields for human-readable tables/CSV. ([get all submissions](https://www.fillout.com/help/api-reference/get-all-submissions), [form metadata](https://www.fillout.com/help/api-reference/get-form-metadata))

## Writes, deletion, and webhooks

Creating submissions is an import facility, not a substitute for a respondent completing the form. Each request accepts at most 10 submissions, identified by form question IDs and optional URL-parameter, scheduling, payment, timestamp, and login data. Most importantly, Fillout says API-created submissions appear in Results but **do not trigger email notifications, workflows, or integrations**. A skill must surface that warning before import; users expecting normal form automation would otherwise get silent behavioral differences. ([create submissions](https://www.fillout.com/help/api-reference/create-submissions))

Deletion is a direct `DELETE` by form ID and submission ID. The REST reference does not document a dry run, recycle bin, undo, or restore response. A local integration should not expose this through a generic request command. If later included, use an exact `delete-submission` command that first reads and displays the target, requires the exact IDs, and emits an audit record without logging answers or the token. ([delete submission](https://www.fillout.com/help/api-reference/delete-submission-by-id))

The webhook API registers a URL for a form and returns an integer ID; removal requires that saved ID. Delivery payloads use the same shape as entries in the submissions endpoint's `responses` array. The REST webhook reference does not document listing registrations, event selection, a signing secret/signature, retry behavior, timeout expectations, ordering, or delivery guarantees. Consequently, a receiver should treat payloads as untrusted input, be idempotent by `submissionId`, respond quickly, and reconcile periodically via the submissions GET endpoint. These receiver behaviors are defensive recommendations, not Fillout-documented guarantees. ([create webhook](https://www.fillout.com/help/api-reference/create-a-webhook), [remove webhook](https://www.fillout.com/help/api-reference/remove-a-webhook))

## Recommended local shape

### Phase 1: useful read-only interface

Provide a human-authored skill that:

- names `FILLOUT_API_KEY` but never contains its value; and
- records the non-secret API base URL shown in the Fillout dashboard (or passes it through ordinary helper configuration). This repository reserves `.env` for credentials, so the base URL should not become another environment setting.

Have it invoke a checked-in helper with narrow subcommands such as:

```text
fillout forms list
fillout forms describe <form-id>
fillout submissions list <form-id> [--after ...] [--before ...]
                                  [--status finished|in_progress]
                                  [--search ...] [--sort asc|desc]
                                  [--include-preview] [--include-edit-link]
fillout submissions get <form-id> <submission-id>
```

The helper should validate IDs and date-times, URL-encode query parameters, cap each page at 150, paginate automatically when requested, throttle to at most 5 requests/second, reject non-HTTPS custom base URLs unless explicitly configured for a trusted self-hosted deployment, redact authorization headers/errors, and output JSON by default. A local `--table` or `--csv` renderer can be convenience-only so no response fields are silently lost.

This provides realistic agent tasks: enumerate available forms; discover question IDs and labels; answer questions over recent responses; find in-progress or matching submissions; fetch a specific submission; export a bounded date range; and obtain an edit link. It cannot build/edit forms or directly patch a submission through the documented API.

### Phase 2: explicitly separated mutations

Only add these after the read workflow is proven:

```text
fillout submissions import <form-id> --file <json>
fillout submissions delete <form-id> <submission-id>
fillout webhooks create <form-id> <https-url>
fillout webhooks remove <webhook-id>
```

Do not expose arbitrary method/path flags. Validate import batches at 10 or fewer, resolve field IDs from metadata, prominently report that imported submissions do not run notifications/workflows/integrations, and store webhook IDs locally so removal remains possible. Treat submission content as potentially sensitive personal/payment/scheduling data and avoid copying raw responses into logs or long-lived scratch files.

## Viability rating

- **Technical feasibility: high.** No SDK or MCP server is required; the documented API is compact and ordinary HTTP/JSON.
- **Read workflow usefulness: high.** Forms, metadata, rich filtering, bounded pagination, and individual submission lookup cover a strong local analysis/search use case.
- **Mutation coverage: moderate.** Imports, deletion, and webhook configuration exist, but there is no documented direct update-submission or form-management REST surface, and imports bypass normal automation.
- **Safety as a shell-backed skill: moderate to low unless the environment is trusted.** Fillout does not document a read-only/scoped account key, while the same key reaches destructive endpoints. A narrow helper improves reliability and prevents mistakes; only a proxy/MCP boundary that withholds the raw key can enforce an operation allowlist.

Overall recommendation: **proceed with a read-first skill/helper**, using an environment variable for the token and a configurable dashboard-provided base URL. Do not provide the API key during design or commit it anywhere. Validate the helper against a non-critical form only after its interface and redaction behavior have been reviewed.
