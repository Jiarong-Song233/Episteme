# ep — terminal capture for Episteme

A thin client: REST for recall and human review, MCP `distill` for the host's sourced reading. The service is
the sole owner of the SQLite graph. The CLI calls no model and adds no runtime dependencies.

## Start

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm serve --scene capture --blank
```

Keep this terminal running. `capture` composes dev, Learn and discussion into one service, one graph and one
review queue. The default graph is `~/.episteme/learn.db`; use `--graph <path>` to choose a new file. Existing
single-scene launchers (`--scene dev|learn|discussion`) remain available. A graph containing custom dimensions
should be reopened with the same profile or the superset `capture` profile.

In another terminal, use `pnpm ep ...` from the repository, `node <repo>/packages/cli/bin/ep.mjs ...` from any
working directory, or install the optional `ep` launchers and host skills:

```powershell
node scripts/install-capture-client.mjs --dry-run
node scripts/install-capture-client.mjs
```

The installer adds the skill to Claude Code (`~/.claude/skills`), Codex (`~/.agents/skills`) and Grok
(`~/.grok/skills`). It adds launchers to `%APPDATA%/npm` on Windows or `~/.local/bin` elsewhere, and refuses to
overwrite unrecognised files. It changes no host configuration, hooks or credentials. Start a new host session
to discover the skill; invoke `episteme-capture` for a relevant task. The skill is advisory and does not install
a background auto-capture hook.

## Credentials

`EPISTEME_URL` defaults to `http://127.0.0.1:4321`. Agents use `EPISTEME_AGENT_TOKEN`. In local mode agents may
leave it empty. Human commands use `EPISTEME_HUMAN_TOKEN` (the old `EPISTEME_TOKEN` name remains compatible).
Use the service's printed human credential only in your own review terminal:

```powershell
$env:EPISTEME_HUMAN_TOKEN = '<the token printed by this running service>'
ep pending
ep accept <suggestion-id>
```

`accept`, `reject`, `add` and `record` refuse to run without a human credential. Shared deployments also enforce
the credential's role server-side. Shell environment names do not upgrade an agent credential to human. Local
credentials change at restart; avoid saving them as permanent environment variables. A shell with access to the
human's credential is not a security boundary, as the service documentation explains.

## Commands

All commands accept `--json`; successful JSON goes to stdout, errors are `{ "error": { "code", "message" } }`
on stderr with a nonzero exit. Boolean flags do not consume positional text. Requests have a 10-second timeout.

| command | behavior |
| --- | --- |
| `ep recall <question> [--summary] [--scope s]` | return prior understanding, state and ranking reasons; summary uses the service's compact entries |
| `ep recall <question> --scope s --only-scope` | filter the finite recall window to exact scope matches; reports `filteredWindow: true` |
| `ep note <text> --scene dev|learn|discussion [--scope context] [--source path] [--why reason]` | propose a 2–1000-character passage, preserving its source and verbatim quote |
| `ep notes --scene dev|learn|discussion [--scope context]` | list that scene's confirmed nodes and all recorded dimensions |
| `ep pending` / `ep reflect` | read pending proposals / graph progress |
| `ep accept <id>` / `ep reject <id>` | the person's decision, through the existing review endpoint |
| `ep add <text> [--kind claim|concept]` | directly state the person's own node |
| `ep record <nodeId> --set dimension=level [--reason text]` | record a state change as the person |
| `ep distill --from git [-n 1..100] [--dry-run]` | mechanically capture commit subjects with full commit ids; review before treating them as lessons |
| `ep distill --from - [--scene ...] [--dry-run]` | read a source object or a simple note array from stdin |
| `ep thread open <title> --scene discussion` | retain a raw discussion in a thread, outside the understanding graph |
| `ep thread turn <id> <text> --speaker learner|agent` | append raw words; credential determines provenance |
| `ep thread show <id>` / `ep thread distill <id> --scene discussion` | inspect raw turns / rule-based distill to pending candidates |

`--dry-run` validates input and prints a preview without contacting the service or writing anything. Simple
arrays are validated entirely before the first request; a network failure in a batch may still leave earlier
proposals pending, which `ep pending` shows.

## Scope and one graph

A note defaults to `scene:dev`, `scene:learn` or `scene:discussion`. A context such as `--scope project:episteme`
becomes `scene:dev:project:episteme` when `--scene dev` is selected. A fully qualified scope must match the
selected scene. Notes lists filter exact contexts, or the entire scene if no context is given.

Recall keeps ADR 0015's behavior: `--scope` is a ranking preference, **not a privacy boundary**. Related
understanding from another scene can remain relevant. With `recall --scene dev --scope project:episteme`, the
same prefix expansion applies; without `--scene`, pass the full recall scope. `--only-scope` performs an exact
client-side filter on the service's bounded window (at most eight ranked nodes); it can underfill and does not
claim to exhaust every scoped node. Permissions are enforced by identity and visibility on the service.

## Host-assisted reading

The host model supplies the interpretation. Pipe a JSON object containing `text`, `title`, `candidates`, and
optionally `learner`, `hostSession`, `submissionId`, `scope` to `ep distill --from - --scene ...`. This goes
through the **existing MCP tool**, preserving ADR 0011's separation from the REST material reader. Its quote,
role, relationship and idempotency checks remain the authority. The candidate contract and an example have one
home in [the capture skill](../../integrations/skills/episteme-capture/SKILL.md).

```powershell
Get-Content -Raw -Encoding utf8 reading.json | ep distill --from - --scene discussion --dry-run --json
Get-Content -Raw -Encoding utf8 reading.json | ep distill --from - --scene discussion --json
```

A simple array `[{"text":"A reusable lesson","why":"Why it matters","source":"git:<full commit id>"}]` uses the
short-note route, with a verified quote of its own text. Full source objects are preferable for corrections,
evidence, questions and `contradicts`/`revises` relations. Quotation proves source text, not truth or mastery.

## Verification and limits

- `tests/capture-scene.test.ts`: one file across restart, source provenance, scoped lists, a real agent's proposal
  and refused decision, invalid scope and oversize note.
- `tests/cli.test.ts`: subprocess Learn/discussion capture, state and compact recall, exact-window filtering,
  MCP quote refusal, contradiction, idempotent retry, whole-batch validation and dry-run.
- [Obsidian integration](../../integrations/obsidian/README.md): real-desktop smoke command and manual installation.
- [Retrieval evaluation](../../docs/research/evaluation/cli-recall.md): fixed corpus and an explicit optional real
  embedding endpoint. No learned embedding quality or learning benefit is claimed without measurements.

Dev/discussion packs currently reuse the legacy common Learn vocabulary. `validity` and `agreement` are settable
by the person; the current distillation policy does not automatically infer those axes. Workbench progress's
“settled” still uses its existing confidence/articulation rule, not either new axis.
