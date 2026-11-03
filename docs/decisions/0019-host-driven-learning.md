# 0019 — Learning driven by the host agent, on evidence that outlives a session

Status: **proposed** (2026-11-03). Depends on [ADR 0013](0013-repository-boundary.md) for scene tools,
[ADR 0015](0015-threads-and-scene-records.md) for threads and scene records, [ADR 0012](0012-human-review-security.md) and
[ADR 0016](0016-delegated-confirmation.md) for who may confirm. Changes no permission boundary.

## Context

The workbench teaches through a model of its own, step by step, and only from its web page. What a learner got wrong
exists only as a per-plan `Attempt` keyed by a free-text focus, so a later session cannot find it. An agent host such
as Claude Code can reach the graph over MCP, but has nothing to run a learning flow with.

The goal is one loop: a real host teaches; behaviour is saved with a stable link; a new session reads what is
unresolved; the host chooses what to do next; the person confirms; the web page shows the structured result. It must
show that learning needs no web chat, that the server's model does not teach, that results carry across sessions, and
that an agent's inference does not become the person's understanding.

## Decision

**The host decides how to teach. The workbench, as a scene, keeps the record and enforces the rules of that record.
Nothing in Core or the MCP package learns about teaching.**

| layer            | owns                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| MCP              | the protocol, identity of the caller, the built-in tools (`propose`, `thread_*`)   |
| Application      | state, the one decision path, delegation, scene records                            |
| workbench scene  | objectives, plans, evidence and the rules below; the reading of a gap              |
| host agent       | which activity next, what to ask, how to judge an answer and why                   |

### 1. Objectives give evidence a stable address

```ts
interface Objective {
  readonly id: string // ob_<hash of the space and the normalized label>
  readonly space: string
  readonly label: string
  readonly createdAt: number
  readonly createdBy: string
}
```

A step and a piece of evidence name an objective by id. The id is derived from the normalized label (NFKC, trimmed,
whitespace collapsed, lower-cased), so the same words in another session or plan are the same objective, and a step
written before this ADR maps to one by its `focus` without any write. `learn_context` lists a space's objectives, so
a host reuses an id rather than rephrasing.

An objective has no prerequisites, parents or weights. It is an address, not a curriculum. Rephrasing does split an
objective in two; merging is a later, person-only operation if that proves to matter.

### 2. Evidence is append-only and does not copy words

```ts
interface LearningEvidence {
  readonly id: string // the caller's submission id
  readonly at: number
  readonly recordedBy: string
  readonly space: string
  readonly plan: string
  readonly step?: string
  readonly objective: string
  readonly kind: 'attempt' | 'statement' | 'feedback' | 'move' | 'candidate'
  /** Where the learner said it. The words stay in the thread: start, end and a digest of them, never a copy. */
  readonly source?: {
    readonly thread: string
    readonly turn: string
    readonly start: number
    readonly end: number
    readonly sha256: string
  }
  /** The recording agent's judgement, always marked as such. */
  readonly assessment?: {
    readonly verdict: 'supports' | 'partial' | 'contradicts' | 'unclear'
    readonly method: 'agent' | 'mechanical'
    readonly reason: string
    readonly diagnosis?: string
  }
  readonly move?: { readonly activity: string; readonly reason: string }
  readonly suggestion?: string // kind: 'candidate'
}
```

Records live in the scene's namespace under `evidence/`, one per person. `method` is set by the server: an MCP caller
always records `agent`.

### 3. The server keeps the rules; the host keeps the choices

Prompts carry teaching. They carry no rule. These hold whatever the host does, and each refuses with a code:

| rule                                                                                | refusal                 |
| ----------------------------------------------------------------------------------- | ----------------------- |
| A step goes pending → active → done or skipped; one active at a time; none reopens  | `invalid_transition`    |
| Done needs an `attempt` or `statement` on that step; otherwise it can only be skipped | `no_evidence`           |
| `attempt` and `statement` need a source; the quote must occur in a learner turn      | `quote_not_found`       |
| The source's thread is the caller's, in this space                                  | `thread_outside_space`  |
| The step belongs to the plan, the objective to the plan's space                     | `objective_outside_plan` |
| A candidate names a suggestion of this person, in this space                        | `unknown_suggestion`    |
| Every write carries the plan version it read                                        | `version_conflict`      |
| Every write carries a submission id; the same one with other content is refused     | `submission_conflict`   |
| A plan the host runs cannot be moved by the page's model routes                     | `host_driven`           |

A write repeated with the same submission id returns the first result and changes nothing. Checks and the write run
one at a time per person, so a version check cannot be overtaken.

A `learner` turn is relayed by the host. The service cannot tell that a person said it, and every turn records who
sent it (`by`). So evidence is a record of what was relayed, never state, and the page says who recorded it.

### 4. A gap is what the evidence shows, and never says mastered

A gap is computed from evidence on each read and is never stored. It opens when an attempt is assessed `partial` or
`contradicts`. After that:

| status      | means                                                         |
| ----------- | ------------------------------------------------------------- |
| `open`      | the last assessed attempt went wrong; `retries` counts tries  |
| `retried`   | a later attempt exists and has no verdict either way yet      |
| `supported` | a later attempt was assessed `supports`, by whom is shown     |

A later wrong attempt returns the gap to `open`. A gap has no closed state: `supported` is one recorded answer judged
by an agent. Whether the person holds an understanding is a separate reading:

```ts
type Confirmation = 'none' | 'pending' | 'delegated' | 'person'
```

No field or word for mastery exists in this model, and no combination of the two readings produces one. As on the
understanding page already: confirming is not mastering.

### 5. Five tools, with the built-ins for the rest

The first draft had eight. Reads merge, because they share a permission and a shape. Writes stay apart wherever their
checks and their log lines differ, because a host logs the tool name and a flat `action` field would blur it; a union
at the top of a schema is also not accepted by every host (see `proposalFrom`).

| tool                | read only | does                                                                   |
| ------------------- | --------- | ---------------------------------------------------------------------- |
| `learn_context`     | yes       | spaces, activities, objectives with gaps, the running plan and its step |
| `learn_plan_start`  | no        | a space if needed, objectives, ordered steps, on a thread of this space |
| `learn_plan_change` | no        | adds or skips steps ahead; earlier ones stay, by the existing edit rules |
| `learn_step`        | no        | `enter`, `complete` or `skip` the current step                         |
| `learn_observe`     | no        | appends one piece of evidence                                          |

`thread_open` and `thread_append` keep the words. `propose` makes a candidate, and asks the person where the host can
show a form. No `learn_*` tool can decide, and they receive only `SceneView`, as every scene tool does.

### 6. Confirmation keeps its three existing paths

| path        | who                      | where                                  | recorded as              |
| ----------- | ------------------------ | -------------------------------------- | ------------------------ |
| review      | a person's credential    | `decide` over REST, the web page       | `confirmed`              |
| elicitation | a form the host showed   | the `propose` retry, local mode only   | `confirmed`, its channel |
| delegation  | the service for a person | a live grant covering the scope        | `delegated`              |

This ADR changes none of them. An earlier draft of the plan turned delegation off for the workbench through a new
Application option. It is not needed and is withdrawn: no workbench page or tool grants a delegation; only a person's
own `POST /delegations` does, and they may want it (ADR 0016). So a delegated acceptance is reported as
`delegated`, never as `person`, and a gap does not move because of any confirmation. If a stricter "never delegated
here" is wanted, it is a change to a permission boundary and gets its own review.

An elicitation answer rests on the local host showing the form to someone (ADR 0012, decision 4). The first loop
confirms on the web page, the stronger path. Whether a real host shows the form is measured, not assumed.

### 7. The web page shows results, not the transcript

`GET /api/v1/scene/workbench/sessions?space=` gives, per plan: topic, objectives, gaps, candidates, what the person
confirmed, open questions and corrections. No turn text. Reaching the words is a deliberate step through the existing
thread view, and only for the owner.

## Stored data

This ADR adds record kinds and optional fields, under the existing format: no layout change, no migration, and
existing plans read as they are. Export and backup carry them because they are companion records.

ADR 0018 is a separate decision, still proposed, and says it has no graphs to carry over. That was checked as follows.

| case                                | today                                                                |
| ----------------------------------- | -------------------------------------------------------------------- |
| `--graph old.jsonl`                 | refused, file unchanged                                              |
| format-1 SQLite (`main`'s backend)  | refused, file unchanged (it used to get a new header before refusal) |
| a SQLite file of something else     | refused, file unchanged (it used to be given our tables)             |
| `learn.jsonl` beside a missing `.db` | refused with the reason (it used to start empty, reading as lost work) |
| a copy                              | `backUp` (online, once before first publication); `workbench export` |
| restoring                           | `workbench import` into a new file only; checksum and read-back first |

What remains open, for the owner of ADR 0018: there is no way to bring a JSONL or format-1 graph forward. `main` writes
both today. Whether anyone holds one cannot be concluded from one machine. A read-only converter to a new file would
close it; it is small, but ADR 0018 rejects importers, so it is not added here. There is also no routine backup: the
only automatic copy is the one before the first publication.

## Deferred: deleting what was said

Not built here. Recorded so it is done in this order, before raw sessions are kept for long or shared widely.

1. **Inventory.** The words live in thread turns, and also in `.before-sharing` backups, exports, drafts' excerpts
   and origins of accepted nodes. Evidence adds none (section 2).
2. **Who.** Deleting is a person-only route, like `decide`. An agent credential gets `human_required`, and no MCP tool
   exists for it.
3. **Tombstone.** A deleted turn keeps its id, sequence and a marker, so evidence pointing at it reads "the words were
   deleted", and its digest no longer resolves. A verdict that rested on it stays, marked.
4. **History.** The graph's history is append-only and saved whole. Removing words from a node's origin is a rewrite of
   that history; decide it separately from deleting a turn.
5. **Retention.** A time limit, if one is wanted, is a policy over 2–4.

The risks until then: a backup or export outlives a deletion, and that must be stated at the point of deleting; a quote
in a publication is a separate act by the person and is withdrawn on its own (ADR 0014); and nothing today lets a
person remove a turn at all.

## Testing

| test                 | proves                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| the rules            | each refusal above, and that it changes nothing                                       |
| across sessions      | a gap recorded on one thread and plan is found from another, by objective             |
| gap readings         | open, retried and supported are distinct; a later wrong attempt returns to open       |
| no mastery           | no confirmation moves a gap, and no answer says mastered                              |
| delegated stays apart | a delegated acceptance reads `delegated`; the hypothesis scene is untouched          |
| no model             | the loop passes with a model that throws on any call                                  |
| real host            | Claude Code over MCP, two sessions, compared with the same host and a prompt alone    |

## Alternatives considered

- **Keep `focus: string` as the link.** Two sessions wording it differently lose the connection, and nothing says so.
- **A knowledge graph of objectives.** Prerequisites are a curriculum, which the host can reason about without it.
- **A policy engine choosing the activity.** That is the host's job; a rule here would compete with it.
- **Storing a copy of the quote in evidence.** Simpler to read, and a second copy to chase on every deletion.
- **One `learn` tool with an `action`.** Fewer names, but one schema with every field optional and one log line for all.
