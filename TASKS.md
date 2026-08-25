# Tasks

Factual log of discrete work packages done on haiflow, kept alongside the code they changed. Newest first.

---

## Pool stability: stop the wedged-member failure modes

**Branch:** `fix/pool-stability`
**Symptom:** worker pools got stuck for long periods, timed out, and mishandled sessions — work silently stopped moving.

Three independent defects combined to produce this. All three let a pool member sit `busy` on work that could never finish, which stalls the member's queue and (for map runs) the fan-in.

### B1 — a failed `sendToTmux` no longer leaves the member stuck busy

`dispatchOrQueue` and `drainQueue` both called `sendToTmux` and ignored the boolean result. When the send failed (tmux session gone, TUI wedged), the session stayed `busy` with a `currentTaskId` forever: the Stop hook never fires for a prompt that never landed, so nothing ever released the member.

- `dispatchOrQueue` now checks the return. On failure it records the task as `failed`, releases the session back to `idle` (tmux still running) or `offline` (tmux gone), logs `dispatch_failed`, and returns a new `"failed"` outcome so callers can react.
- `drainQueue` applies the same handling and additionally puts the item it had already spliced out back at the head of the queue, so a transient send failure does not lose queued work (logs `queue_drain_failed`).
- `/trigger` got the same release-on-failure it was missing: it recorded the failed task but left the busy state in place.
- Callers map `"failed"` to a visible outcome: `/pool/:name/trigger` returns `500`, `/map` marks the shard `(failed: send to tmux failed)` in the reduce, the pipeline records the delivery as `failed`, the reducer logs `map_reduce_dispatch_failed`, ingest logs `ingest_dispatch_failed`.

### B2 — offline pool members are auto-started, or the request fails loudly

`pickPoolMember` skipped offline members, and when every member was offline it queued the work on the first member and answered `queued_offline`. Nothing ever starts an offline member on its own, so that work waited forever.

- `pickPoolMember` now returns the first offline member flagged `offline` instead of silently queueing on it.
- `/pool/:name/trigger` and `/map` call `ensurePoolMemberStarted`, which brings the member up via the existing `startClaudeSession` using the cwd/model it last ran with (same contract as `/session/start`). If the start fails, the request fails: `503` for `/pool/:name/trigger`, a `(skipped: ... auto-start failed)` shard for `/map`. Logs `pool_member_autostarted` / `pool_member_autostart_failed`. The `queued_offline` dead end is gone from the pool paths.

### B3 — the watchdog recovers sessions whose tmux died

A busy session whose tmux process died can never fire the Stop hook. The watchdog only logged it and moved on, because the recovery path required both `HAIFLOW_WATCHDOG_RECOVER=true` and a live tmux session.

- The watchdog now handles the dead-tmux case unconditionally: it marks the session `offline`, requeues the orphaned `currentTaskId` at the head of the queue, and closes the ledger row as `failed` with `error: "watchdog:tmux_died"`. This needs no opt-in because there is nothing to interrupt — it is state hygiene, and it is safe.
- The general recovery path for a wedged-but-alive session is unchanged and still opt-in via `HAIFLOW_WATCHDOG_RECOVER`. Logs `watchdog_dead_tmux`.

### Tests

The old pool tests seeded "fake" members (a `state.json` with no tmux behind it), which is why the ignored-send-failure bug passed: the send always failed and nobody checked. The pool/queue suites now dispatch through a fake `tmux` (`tests/fixtures/fake-tmux.ts`, exposed on the server PATH via a shim) that accepts sends for healthy sessions and reports a dead tmux for sessions named `gone*` — so both the happy path and the failure paths run hermetically, including on CI where there is no tmux at all.

Added coverage:
- failed send returns `500` and does not wedge the member busy (B1)
- a failed drain requeues the item and releases the member (B1)
- an all-offline pool fails loudly when the member can't auto-start (B2)
- an all-offline pool skips map shards loudly in the reduce (B2)
- a failed map shard is reported in the run instead of hanging it (B1)
- dispatch auto-starts an offline member and delivers the prompt (B2; real tmux + fake claude, skips where the shim can't reach the pane safely)
- the watchdog recovers a dead-tmux busy session and requeues the orphan even with `HAIFLOW_WATCHDOG_RECOVER` off (B3)
- the watchdog still leaves a live wedged session alone when `HAIFLOW_WATCHDOG_RECOVER` is off (B3)

`tests/api.test.ts` "drains queue after stop" was updated to assert the corrected behaviour (requeue + release) instead of the old lost-item/stuck-busy behaviour.
