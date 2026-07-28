/**
 * What went wrong, as a sentence.
 *
 * Everything the coworker touches can throw something that is not an `Error` — a
 * subprocess, a Slack call, a JSON parse — and every one of those failures ends up
 * either in the instance's log or in a Thread, read by a person. So the unwrapping
 * happens in one place rather than being re-improvised at each edge.
 */
export function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
