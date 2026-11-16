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
export EPISTEME_TOKEN=<the token the service printed>

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
| `ep recall <question> [--scope s] [--summary]` | prior understanding relevant to a question, with the score and state each item was retrieved on |
| `ep reflect` | what you have recorded, and how many proposals wait |
| `ep pending` | proposals an agent (or `ep note`) made, waiting for you |
| `ep accept <id>` / `ep reject <id>` | the person's decision on one proposal |
| `ep add <text> [--kind claim\|concept] [--scope s]` | a node you state yourself |
| `ep note <text> [--why s] [--scope s]` | propose a dev lesson (scene route `POST /scene/dev/notes`) |
| `ep notes` | list dev notes and their validity |
| `ep record <nodeId> --set dim=level [--reason s]` | record your state on a node |
| `ep distill --from git [-n N] [--dry-run]` | propose lessons from recent commits |

Environment: `EPISTEME_URL` (default `http://127.0.0.1:4321`), `EPISTEME_TOKEN` (the person's token; needed to
accept, reject, add and record).

This is a first slice. A TypeScript package and an MCP-backed mode can follow; the REST contract is fixed
already, so the surface stays stable.
