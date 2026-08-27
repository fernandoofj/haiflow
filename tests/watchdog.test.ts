import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { SERVER_ENTRY, stopServer } from "./fixtures/server";

const TEST_PORT = 9880;
const TEST_DIR = "/tmp/haiflow-watchdog-test";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;

// The watchdog also recovers busy sessions whose tmux died. These unit tests
// seed busy sessions without tmux on purpose, so keep the tick far away while
// they run — the dedicated suite below tests that recovery on its own server.
//
// The LIVE-session test at the bottom needs one property, and `Bun.which("tmux")`
// asserted a different one: that SOMETHING named tmux exists. What it actually
// needs is that a session it starts is reported alive by `tmux has-session` —
// the same call the server's isTmuxRunning makes. Anything else and the test
// reads "the tmux died" and measures the wrong branch of the watchdog.
//
// Nothing here spawns claude, so the cost of being wrong is a puzzling red
// rather than a real Claude session (see tests/consumer-lifecycle.test.ts for
// where that same shape did cost that). Still cheap to just ask.
const TMUX_PROBE_SESSION = `haiflow-watchdog-probe-${process.pid}`;
const TMUX_IS_LIVE = (() => {
  if (!Bun.which("tmux")) return false;
  try {
    Bun.spawnSync(["tmux", "kill-session", "-t", TMUX_PROBE_SESSION]);
    if (Bun.spawnSync(["tmux", "new-session", "-d", "-s", TMUX_PROBE_SESSION]).exitCode !== 0) return false;
    return Bun.spawnSync(["tmux", "has-session", "-t", TMUX_PROBE_SESSION]).exitCode === 0;
  } catch {
    return false;
  } finally {
    Bun.spawnSync(["tmux", "kill-session", "-t", TMUX_PROBE_SESSION]);
  }
})();

let server: ReturnType<typeof Bun.spawn>;
const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object, headers: Record<string, string> = authHeaders) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

function seed(session: string, claudeId: string, state: object) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify(state));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  server = Bun.spawn([process.execPath, SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_GUARDRAILS: "false",
      // Keep the tick far away while these unit tests run: they seed busy
      // sessions without tmux on purpose (see the note near TMUX_IS_LIVE).
      HAIFLOW_WATCHDOG_INTERVAL_MS: "60000",
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(async () => {
  await stopServer(server, TEST_DIR);
});

describe("POST /hooks/notification", () => {
  test("flags a busy session as waiting", async () => {
    seed("wd-busy", "claude-wd-busy", { status: "busy", since: new Date().toISOString(), currentTaskId: "t1" });
    const { data } = await api("/hooks/notification", "POST", {
      session_id: "claude-wd-busy",
      message: "Claude needs your permission to use Bash",
    });
    expect(data.ok).toBe(true);

    const status = await api("/status?session=wd-busy");
    expect(status.data.waiting).toBe(true);
    expect(status.data.waitingMessage).toContain("permission");
  });

  test("ignores notification on an idle session (normal idle-waiting)", async () => {
    seed("wd-idle", "claude-wd-idle", { status: "idle", since: new Date().toISOString() });
    await api("/hooks/notification", "POST", { session_id: "claude-wd-idle", message: "waiting for input" });
    const status = await api("/status?session=wd-idle");
    expect(status.data.waiting).toBeUndefined();
  });

  test("returns ok for unknown session", async () => {
    const { data } = await api("/hooks/notification", "POST", { session_id: "nope" });
    expect(data.ok).toBe(true);
  });

  test("notification is rejected through a proxy header", async () => {
    const res = await fetch(`${BASE}/hooks/notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /interrupt", () => {
  test("404 when the session is not running", async () => {
    const { status, data } = await api("/interrupt", "POST", { session: "not-running" });
    expect(status).toBe(404);
    expect(data.error).toContain("not running");
  });

  test("requires auth", async () => {
    const res = await fetch(`${BASE}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("prompt hook clears a prior waiting flag", async () => {
    seed("wd-clear", "claude-wd-clear", { status: "busy", since: new Date().toISOString(), waiting: true, waitingMessage: "blocked", currentTaskId: "t9" });
    await api("/hooks/prompt", "POST", { session_id: "claude-wd-clear", prompt: "carry on" });
    const status = await api("/status?session=wd-clear");
    expect(status.data.waiting).toBe(false);
  });
});

// --- Dead-tmux recovery ---
//
// A busy session whose tmux is gone can never fire the Stop hook: without
// intervention it sits busy forever, its current task an orphan and its queue
// starving behind it. The watchdog must transition it to offline and close the
// orphan's ledger row — and it does so even with HAIFLOW_WATCHDOG_RECOVER off,
// because there is nothing to "recover" (no pane to interrupt): it is state
// hygiene.
//
// What it must NOT do by default is run the orphan again. See the two tests
// below: the default drops it, and HAIFLOW_WATCHDOG_REQUEUE_ORPHAN=true opts
// back into the old behaviour.
describe("watchdog dead-tmux recovery", () => {
  const WD_PORT = 9891;
  const WD_DIR = "/tmp/haiflow-watchdog-dead-test";
  const WD_BASE = `http://localhost:${WD_PORT}`;
  let proc: ReturnType<typeof Bun.spawn>;

  async function wdApi(path: string, method = "GET", body?: object) {
    const res = await fetch(`${WD_BASE}${path}`, {
      method,
      headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  }

  function wdSeed(session: string, state: object) {
    const dir = `${WD_DIR}/${session}`;
    mkdirSync(`${dir}/responses`, { recursive: true });
    writeFileSync(`${dir}/session-id`, `claude-${session}`);
    writeFileSync(`${dir}/state.json`, JSON.stringify(state));
  }

  beforeAll(async () => {
    if (existsSync(WD_DIR)) rmSync(WD_DIR, { recursive: true });
    proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(WD_PORT), HAIFLOW_DATA_DIR: WD_DIR, HAIFLOW_API_KEY: TEST_API_KEY,
        HAIFLOW_GUARDRAILS: "false",
        // Fast tick so the recovery is observable inside the test. Note
        // HAIFLOW_WATCHDOG_RECOVER stays UNSET (default false): dead-tmux
        // recovery must not require the opt-in.
        HAIFLOW_WATCHDOG_INTERVAL_MS: "300",
      },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${WD_BASE}/health`)).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Server failed to start");
  });

  afterAll(async () => {
    await stopServer(proc, WD_DIR);
  });

  test("recovers a busy session whose tmux died, WITHOUT rerunning the orphan", async () => {
    wdSeed("wd-dead", {
      status: "busy", since: new Date().toISOString(),
      currentTaskId: "orphan-1", currentPrompt: "finish me",
    });
    writeFileSync(`${WD_DIR}/wd-dead/queue.json`, JSON.stringify([
      { id: "q-behind", prompt: "behind", addedAt: "2025-01-01T00:00:00Z" },
    ]));

    // Wait for a watchdog tick to notice the dead tmux.
    let status: any;
    for (let i = 0; i < 60; i++) {
      status = (await wdApi("/status?session=wd-dead")).data;
      if (status.status === "offline") break;
      await Bun.sleep(150);
    }
    expect(status.status).toBe("offline"); // no longer stuck busy
    expect(status.currentTaskId).toBeUndefined();

    // The orphan is NOT put back: it may already have written somewhere, and
    // nothing here can tell. The item that was waiting behind it is untouched.
    const queue = await wdApi("/queue?session=wd-dead");
    expect(queue.data.items.map((q: any) => q.id)).toEqual(["q-behind"]);

    // The ledger row is closed as failed (not left "running" forever).
    const tasks = await wdApi("/tasks?session=wd-dead");
    const row = tasks.data.tasks.find((t: any) => t.id === "orphan-1");
    expect(row).toBeDefined();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("watchdog:tmux_died");
  }, 20000);

  test.skipIf(!TMUX_IS_LIVE)("leaves a LIVE wedged session alone when WATCHDOG_RECOVER is off", async () => {
    // The opt-in still gates the general recovery path: only the dead-tmux
    // case is recovered without HAIFLOW_WATCHDOG_RECOVER=true.
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", "wd-live"]);
    try {
      wdSeed("wd-live", {
        status: "busy", since: new Date().toISOString(), currentTaskId: "live-1",
        deadlineAt: new Date(Date.now() - 1000).toISOString(), // already past due
      });
      await Bun.sleep(1500); // several ticks
      const status = await wdApi("/status?session=wd-live");
      expect(status.data.status).toBe("busy"); // alert-only, no recovery
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", "wd-live"]);
    }
  }, 20000);
});
