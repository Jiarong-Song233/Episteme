---
name: episteme-capture
description: Recall a person's confirmed understanding and propose sourced lessons after development, learning or discussion. Use when the user wants Episteme recall, durable lessons, corrections, decisions or conversation distillation.
---

# Episteme capture

Use `ep` against the person's running Episteme service. Start with `ep help --json` when its command contract is unfamiliar. The host supplies the reasoning; Episteme preserves sources, checks quotations and queues candidates for human review.

1. Choose `dev`, `learn` or `discussion` and a context such as `project:episteme` or `course:statistics`. At the start of a relevant task, run `ep recall "<actual question>" --scope scene:<scene>:<context> --json`. Recall scope is a ranking preference; check each result's reasons and state. A remembered claim can be disputed or obsolete.
2. Work normally. Identify a small number of reusable decisions, boundary conditions, corrected misconceptions or unresolved disagreements. Skip routine progress and copied answers. Keep who said what and what was observed separate from the model's inference.
3. Build one JSON source object: `text` is the relevant verbatim conversation or evidence; `title` names its origin; `scope` names the context; `hostSession` is a stable conversation identifier; `submissionId` is stable for retries of this exact payload; `learner` names the person's speaker label if the source is a dialogue; `candidates` uses the contract below.
4. Preview with `ep distill --from - --scene <scene> --dry-run --json`, then pipe the same JSON to `ep distill --from - --scene <scene> --json`. Both commands read stdin. Use a temporary UTF-8 file or a correctly escaped pipe; never interpolate source text into executable shell code. Inspect `refused` and report why candidates were rejected. Retrying an identical `submissionId` is idempotent; changing the payload needs a new id.
5. Report only what was proposed, its source and what still needs the person's decision. The person reviews using `ep pending`, then `ep accept` or `ep reject`, or the Obsidian sidebar. Agent runs receive only `EPISTEME_AGENT_TOKEN` (empty in local mode). Keep human credentials out of agent environments and never call accept/reject/add/record on behalf of an agent.

## Candidate contract

Every candidate has `kind`, `quote` (verbatim source text, 2–1000 characters), `basis` (`stated` only for the person's own quoted turn; otherwise `inferred`) and `rationale`. If the same quote occurs multiple times, specify its 1-based `occurrence`.

- Node: `kind: node`, `ref`, `role: concept|question|claim|evidence`, `label`.
- Relation: `kind: relation`, `from`, `to`, `relation: about|answers|supports|contradicts|revises`. Endpoints are existing ids returned by recall or `cand:<ref>` in this submission.
- State: `kind: state`, `target`, `dimension`, `level`. Let the active domain policy validate it. Preserve conflicting positions; resolution belongs to the person.

A quote confirms that text occurs in the submitted source. It does not prove truth or mastery. Only propose a state change when the quoted evidence actually shows a change.

Example source object:

```json
{
  "title": "SQLite writer discussion",
  "text": "User: SQLite serializes writers using a lock.",
  "learner": "User",
  "hostSession": "session-identifier",
  "submissionId": "session-identifier-reading-1",
  "scope": "project:episteme",
  "candidates": [
    {
      "kind": "node", "ref": "writers", "role": "claim",
      "label": "SQLite serializes writers using a lock",
      "quote": "SQLite serializes writers using a lock",
      "basis": "stated", "rationale": "The person articulated the concurrency constraint"
    }
  ]
}
```

If the service is unavailable, say recall/capture was unavailable and continue the original task. Save a proposed payload only when useful and report its path; never claim it reached Episteme. Keep credentials out of payloads, logs and sources.
