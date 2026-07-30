# 16 — File egress: result artifacts back into the Thread

**What to build:** When the coworker produces a report, export, image, archive, or other
artifact that is more useful as a file than pasted text, it can deliberately place that
artifact in a Job-owned output directory. The wrapper uploads it into the originating
Slack Thread before posting the final answer.

**Blocked by:** 01 — Walking skeleton

**Status:** ready-for-agent

- [x] The Job prompt names a dedicated output directory and says that only files placed
  there will be shared
- [x] Each regular file created there is uploaded to the Thread the Job came from with
  Slack's current v2 upload flow
- [x] Upload requires `files:write`; the required permission is recorded for our Slack app
- [x] A configurable size ceiling is checked before upload
- [x] Symlinks, directories, and paths escaping the output directory are never uploaded
- [x] Every successful upload is followed by a permanent Write record naming the file
- [x] An upload failure is reported honestly in the final answer and does not claim the
  artifact was shared
- [x] A Job that produces no output artifact performs no Slack file call
- [x] Tests drive the top seam and assert on the uploaded bytes, filename, and Thread

## Notes

The uploaded file and its audit receipt are separate on purpose. The file is the result;
the receipt is the permanent accountability record required of every external Write.

Output files remain in the per-Thread workspace after upload, just like the rest of the
Job's working files. Retention is therefore the workspace retention policy rather than a
second cleanup mechanism.

## Comments

**Implemented 2026-07-30.** Every Job gets a flat
`.open-agent/outputs/<job-id>/` dropbox named in its prompt. Regular files placed directly
inside it are uploaded with Slack's v2 flow before the final answer; directories and
symlinks are ignored, and files over the configured ceiling fail before the upload call.
Each successful file is followed by a receipt linked to Slack's permalink when available.

The code and tests are complete. Applying `files:write` to our Slack app and exercising a
real upload remain workspace operations.

**Review-hardened 2026-07-30.** The upload boundary tolerates an output directory removed
by the agent without losing the final Thread response or blocking the next queued Job.
When an upload fails, the wrapper replaces any optimistic attachment claim from the model
with the observed delivery result. Input and output transfer now live in separate modules
with their shared Job-path lifecycle in one place.
