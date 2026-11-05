# Newrite/dsh-peer — `kalpa` branch

A fork of [caelricluo/dsh-peer](https://github.com/caelricluo/dsh-peer) (base `e6cc6dd`, MIT) used to let a
Claude Code session act as the architect for a DeepSeek Harness (DSH) "lead" chat that runs an agent team.
Everything below is a deliberate departure from upstream; the rest of the README still applies.

## Changes

| Area | Upstream | This fork |
|---|---|---|
| Live session vs. guest | The turn timer (10 min) and a dropped guest connection both `cancel()` the live session | By default a guest never cancels a live session; the bridge waits until it and its subagents settle. `liveSession.cancelOnAbort: true` restores upstream |
| Message to a busy session | `steer` into the running turn | `followup` (queued next turn). `liveSession.delivery: steer-when-running` restores upstream |
| Spawn adapters | All four always constructed | `enabledHarnesses` limits them; the bundle patch enables only `dsh`, so no child `claude`/`codex` process runs |
| Thread bound to a live session | The live target was lost after the first message (message route and CLI dropped it), so a follow-up tried to resume the live session as a second writer and DSH refused | Threads record `liveSessionId`; later messages go to the same live session. `POST /v1/threads/:id/messages` forwards `to`; `peer ask/send` carry `--session` on every path |
| DSH → delegator | Only `peer_ask`/`peer_send`, which start a turn on the other side | `peer_notify`: append-only inbox thread (`architect-inbox`) for questions, blockers and progress. No turn runs; the external reader long-polls the thread and answers into the live session |

## `peer_notify`

```jsonc
peer_notify { "text": "Weights as two RGBA8 textures or a second vertex attribute?", "kind": "question" }
// kind: question | blocker | progress | report (default report)
```

The message is stored as `role: "user"`, `from: { harness: "dsh", name: "lead" }`,
`meta: { kind, sessionId }` in the open thread titled `inbox.title` (default `architect-inbox`), created on first use.
Readers follow it with `node scripts/inbox-watch.mjs` (blocks until the next lead message, prints it and exits; the
read cursor lives in `$PEER_HOME/inbox-cursor.json`, and a DSH restart is waited out), `peer read --thread <id> --follow`
or `GET /v1/threads/<id>?after=N&wait_seconds=300`, and reply
with `peer send --thread <work-thread> --session <meta.sessionId> ...`. A final answer to a delegated task is returned
through the original thread automatically and should not be duplicated through the inbox.

## Tests

`node --test test/*.test.mjs`: on Windows the nine adapter/runner tests that execute POSIX `#!` fake CLIs fail, as they
do upstream; the bridge, store, CLI and plugin suites pass.
