# Applications

Applications are where product decisions live: UI, interaction flows, ranking, feeds, notifications, quizzes —
anything whose value depends on one particular product rather than on the graph itself. Nothing here may be a
prerequisite for another, and none of it may be needed by Core to run its tests.

- `apps/service` — the Episteme service. It owns a graph and serves MCP, REST and a built Workspace
  ([ADR 0010](../docs/decisions/0010-episteme-service.md)).

An application is a **view** over the graph. What it keeps beside the graph, such as uploaded material, lives in the
graph's own SQLite file, so one file holds and backs up everything
([ADR 0018](../docs/decisions/0018-sqlite-only.md)).
