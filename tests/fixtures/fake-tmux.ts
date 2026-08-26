#!/usr/bin/env bun
/**
 * Fake tmux — a test double for haiflow's pool/queue tests.
 *
 * It answers the narrow slice of tmux commands haiflow issues (has-session,
 * send-keys, capture-pane, kill-session, list-panes, new-session) so the
 * dispatch, drain and watchdog paths can run hermetically — no real tmux
 * server, and no tmux at all on CI. Tests expose it on the server's PATH via
 * a `tmux` shim (plus `tmux.cmd` on Windows).
 *
 * Sessions whose name starts with `gone` behave as if their tmux session
 * died: has-session, send-keys and capture-pane fail. That lets a test
 * exercise the send-failure paths (dispatch/drain/watchdog) without touching
 * a real pane.
 *
 * capture-pane prints nothing: haiflow's inputBoxCleared() then sees an empty
 * input box and treats the submit as confirmed — the "healthy pane" behaviour
 * for these tests.
 */

const args = process.argv.slice(2);
const cmd = args[0];
const tIndex = args.indexOf("-t");
const target = tIndex >= 0 ? String(args[tIndex + 1] ?? "") : "";
const gone = target.startsWith("gone");

switch (cmd) {
  case "has-session":
  case "send-keys":
  case "capture-pane":
    process.exit(gone ? 1 : 0);
    break;
  case "list-panes":
    process.stdout.write("12345\n");
    process.exit(0);
    break;
  case "kill-session":
  case "new-session":
  default:
    process.exit(0);
    break;
}
