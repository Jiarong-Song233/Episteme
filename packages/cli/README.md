# @episteme/cli — `ep`

A thin terminal client over the Episteme REST API (`/api/v1`). It lets a person, or an agent acting on their
behalf, turn what happens in a terminal into structured understanding that the graph keeps: a proposed lesson
waits for the person's `accept`, and the next `recall` can build on it.

The CLI holds no state and opens no graph itself: the service stays the single owner (ADR 0010). It needs a
running service and, for anything that decides, the person's own token.

```bash
# start the service (dev scene) — it prints its URL and your token
pnpm serve --scene dev --blank --graph ~/.episteme/dev.db

export EPISTEME_URL=http://127.0.0.1:4321
export EPISTEME_HUMAN_TOKEN=<the token the service printed>
# an agent gets only this one: read and propose, never decide
export EPISTEME_AGENT_TOKEN=<an agent token, or omit in local mode>

ep note "用 SQLite 单文件，跨进程靠文件锁保证唯一写入" --why "ADR 0018：两个后端加陈旧锁文件的成本更高"
ep pending                      # the proposal waits here; nothing is the person's yet
ep accept <id>                  # the one human decision; the claim enters the graph
ep notes                        # list dev notes with their validity
ep record <nodeId> --set validity=tested
ep recall "为什么存储选 SQLite"   # what you already hold that bears on the question, with why
ep distill --from git -n 5      # turn recent commits into proposed lessons
```

## Commands

| command | does |
| --- | --- |
| `ep recall <question> [--scope s] [--summary] [--json]` | prior understanding relevant to a question, with the score and state each item was retrieved on |
| `ep reflect [--json]` | what you have recorded, and how many proposals wait |
| `ep pending [--json]` | proposals an agent (or `ep note`) made, waiting for you |
| `ep accept <id>` / `ep reject <id>` | the person's decision on one proposal |
| `ep add <text> [--kind claim\|concept] [--scope s]` | a node you state yourself |
| `ep note <text> [--why s] [--scope s] [--scene dev\|discussion]` | propose a lesson/position (scene route `POST /scene/<scene>/notes`) |
| `ep notes [--scene dev\|discussion]` | list notes/positions with their state |
| `ep record <nodeId> --set dim=level [--reason s]` | record your state on a node |
| `ep distill --from git [-n N] [--dry-run] [--scene s]` | propose lessons from recent commits |
| `ep distill --from - [--scene s]` | propose from a JSON array on stdin, for a host model (ADR 0011) |

Every command accepts `--json`, which prints the service's response unchanged for an agent to consume.

## Scenes

`--scene dev` (the default) records engineering lessons with a **validity** axis (untested → tested → in-prod →
deprecated). `--scene discussion` records positions with an **agreement** axis (none → partial → full). Both
propose through `/scene/<name>/notes` and confirm through the same decision path. Raw conversation stays a
thread (ADR 0015), recorded through the service's `/threads` routes; a position distilled from it is a claim.

## Tokens

| variable | may |
| --- | --- |
| `EPISTEME_AGENT_TOKEN` | read (`recall`, `reflect`, `pending`, `notes`) and propose (`note`, `distill`) |
| `EPISTEME_HUMAN_TOKEN` | everything above, plus `accept`, `reject`, `add`, `record` |
| `EPISTEME_TOKEN` | the old single name; read as the person's token, so existing scripts keep working |

`accept`, `reject`, `add` and `record` refuse to run without a person's token. That is the same boundary the
service enforces: an agent can put a draft in front of the person, never decide it.

## Host-assisted distillation

A host agent (Claude Code, Codex, Grok) can distil a session itself and hand the candidates over; Episteme
still validates and keeps them as proposals:

```bash
printf '%s' '[{"text":"跨进程锁要放在图旁边","why":"多个进程各自锁自己的文件会互相看不见"}]' \
  | ep distill --from - --json
```

## Status

First slice. A TypeScript package and an MCP-backed mode can follow; the REST contract is fixed already, so
the surface stays stable.
