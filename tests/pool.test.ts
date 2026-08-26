import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { installShim } from "./fixtures/shim";

// Absolute entry, spawned with the running bun binary rather than via
// `bun run`: `bun run` interposes a launcher process, and killing the launcher
// leaves the real server alive holding its data dir open — EBUSY on every
// afterAll here, and a stray listening port everywhere else.
const SERVER_ENTRY = resolve(import.meta.dir, "../src/index.ts");

// Kill a spawned server and wait until it is really gone, then remove the dirs
// it was holding. Without the wait, Windows answers rm with EBUSY; the retries
// cover the short window where the handle outlives the process.
async function stopServer(proc: ReturnType<typeof Bun.spawn> | undefined, ...dirs: string[]) {
  proc?.kill();
  await proc?.exited;
  for (const dir of dirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

const TEST_PORT = 9883;
const TEST_DIR = "/tmp/haiflow-pool-test";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;
const BIN_DIR = "/tmp/haiflow-pool-bin";
const PATH_SEP = process.platform === "win32" ? ";" : ":";

// The pool suites dispatch for real, so the server's PATH carries a fake `tmux`
// (tests/fixtures/fake-tmux.ts): healthy sessions accept sends, sessions named
// `gone*` report a dead tmux. That keeps the delivery + failure paths testable
// hermetically — including on CI, which has no tmux at all.
const FAKE_TMUX = join(import.meta.dir, "fixtures", "fake-tmux.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const HAS_TMUX = !!Bun.which("tmux");

let server: ReturnType<typeof Bun.spawn>;
const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

function seedIdle(session: string) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, `claude-${session}`);
  writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "idle", since: new Date().toISOString() }));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  installShim(BIN_DIR, "tmux", FAKE_TMUX);
  // Pool config
  writeFileSync(`${TEST_DIR}/pipeline.json`, JSON.stringify({
    topics: {}, emitters: {},
    pools: {
      workers: { members: ["w1", "w2"] },
      single: { members: ["pw1"] },
      // The fake tmux reports `gone*` sessions as dead: dispatch fails and the
      // pool must surface the error instead of wedging the member busy.
      deadpool: { members: ["gone-pool-member"] },
      // All members offline: dispatch must auto-start them, or fail loudly
      // when it can't — never queue into a dead end. The cwd policy below
      // (request cwds disabled, no server cwd) makes the auto-start fail
      // deterministically without spawning any real claude/tmux.
      offpool: { members: ["ow1"] },
    },
  }));
  for (const s of ["w1", "w2", "pw1", "reducer", "reducer2", "gone-pool-member"]) seedIdle(s);
  // Deliberately NO session-id file: boot recovery revives an offline session
  // when a tmux by that name "runs" (the fake tmux says yes for anything not
  // named gone*), and a seeded session-id would make ow1 idle before the test
  // even starts.
  const ow1 = `${TEST_DIR}/ow1`;
  mkdirSync(`${ow1}/responses`, { recursive: true });
  writeFileSync(`${ow1}/state.json`, JSON.stringify({ status: "offline", since: new Date().toISOString(), cwd: "/tmp" }));

  server = Bun.spawn([process.execPath, SERVER_ENTRY], {
    env: {
      ...process.env,
      PATH: `${BIN_DIR}${PATH_SEP}${process.env.PATH}`,
      PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_GUARDRAILS: "false",
      // Blocks the offline-member auto-start deterministically (see offpool).
      HAIFLOW_ALLOW_REQUEST_CWD: "false",
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
  await stopServer(server, TEST_DIR, BIN_DIR);
});

describe("worker pool", () => {
  test("POST /pool/:name/trigger dispatches to an idle member", async () => {
    const res = await api("/pool/single/trigger", "POST", { prompt: "hello", id: "pt-1" });
    expect(res.status).toBe(200);
    expect(res.data.member).toBe("pw1");
    expect(res.data.where).toBe("sent");
    const status = await api("/status?session=pw1");
    expect(status.data.status).toBe("busy");
    expect(status.data.currentTaskId).toBe("pt-1");
  });

  test("404 for an unknown pool", async () => {
    const res = await api("/pool/ghost/trigger", "POST", { prompt: "x" });
    expect(res.status).toBe(404);
  });

  test("a failed send returns 500 and does not wedge the member busy", async () => {
    // gone-pool-member's tmux is "dead": the prompt never lands, so the Stop
    // hook can never fire. The pool must fail the request and release the
    // member — a silent busy here wedges the member's queue forever.
    const res = await api("/pool/deadpool/trigger", "POST", { prompt: "hello", id: "pd-1" });
    expect(res.status).toBe(500);
    expect(res.data.member).toBe("gone-pool-member");

    const status = await api("/status?session=gone-pool-member");
    expect(status.data.status).toBe("offline"); // tmux gone -> released, not busy
    expect(status.data.currentTaskId).toBeUndefined();

    const tasks = await api("/tasks?session=gone-pool-member");
    const row = tasks.data.tasks.find((t: any) => t.id === "pd-1");
    expect(row).toBeDefined();
    expect(row.status).toBe("failed");
  });

  test("an all-offline pool fails loudly when the member can't auto-start", async () => {
    const res = await api("/pool/offpool/trigger", "POST", { prompt: "hello", id: "po-1" });
    expect(res.status).toBe(503);
    expect(res.data.member).toBe("ow1");
    expect(res.data.error).toContain("offline and could not be auto-started");

    // The member stays offline and NOTHING is queued where nobody would run it.
    const status = await api("/status?session=ow1");
    expect(status.data.status).toBe("offline");
    const queue = await api("/queue?session=ow1");
    expect(queue.data.length).toBe(0);
  });
});

describe("map-reduce", () => {
  test("fans items across the pool and reduces once all return", async () => {
    const map = await api("/map", "POST", {
      items: ["alpha", "beta"],
      pool: "workers",
      mapTemplate: "Summarise: {{item}}",
      reduce: { session: "reducer", promptTemplate: "Combine these:\n{{results}}" },
    });
    expect(map.status).toBe(200);
    expect(map.data.total).toBe(2);
    expect(map.data.reduce).toBe(true);
    const runId = map.data.runId;

    // Both members idle -> both got a shard immediately
    const w1 = await api("/status?session=w1");
    const w2 = await api("/status?session=w2");
    expect(w1.data.status).toBe("busy");
    expect(w2.data.status).toBe("busy");

    // Run not reduced yet
    let run = await api(`/map/${runId}`);
    expect(run.data.reduced).toBe(false);

    // Simulate each worker finishing its shard
    await api("/hooks/stop", "POST", { session_id: "claude-w1", last_assistant_message: "RESULT_A" });
    run = await api(`/map/${runId}`);
    expect(run.data.reduced).toBe(false); // only 1 of 2

    await api("/hooks/stop", "POST", { session_id: "claude-w2", last_assistant_message: "RESULT_B" });
    run = await api(`/map/${runId}`);
    expect(run.data.reduced).toBe(true);
    expect(run.data.collected).toBe(2);

    // Reducer fired with both results
    const reducer = await api("/status?session=reducer");
    expect(reducer.data.status).toBe("busy");
    expect(reducer.data.currentPrompt).toContain("RESULT_A");
    expect(reducer.data.currentPrompt).toContain("RESULT_B");
  });

  test("rejects unknown pool and empty items", async () => {
    expect((await api("/map", "POST", { items: ["a"], pool: "ghost", mapTemplate: "x {{item}}" })).status).toBe(404);
    expect((await api("/map", "POST", { items: [], pool: "workers", mapTemplate: "x" })).status).toBe(400);
  });

  test("a failed shard is reported in the run instead of hanging it", async () => {
    // deadpool's only member has a dead tmux: both shards fail synchronously
    // and the run reduces immediately — instead of sitting unreduced until the
    // (30-minute default) map timeout.
    const map = await api("/map", "POST", {
      items: ["a", "b"],
      pool: "deadpool",
      mapTemplate: "do {{item}}",
    });
    expect(map.status).toBe(200);
    expect(map.data.dispatched.length).toBe(0);

    const run = await api(`/map/${map.data.runId}`);
    expect(run.data.reduced).toBe(true);
    expect(run.data.collected).toBe(2);
  });

  test("an all-offline pool skips shards loudly in the reduce", async () => {
    const map = await api("/map", "POST", {
      items: ["a"],
      pool: "offpool",
      mapTemplate: "do {{item}}",
      reduce: { session: "reducer2", promptTemplate: "merge:\n{{results}}" },
    });
    expect(map.status).toBe(200);
    expect(map.data.dispatched.length).toBe(0);

    const run = await api(`/map/${map.data.runId}`);
    expect(run.data.reduced).toBe(true);

    // The failure surfaces in the fan-in, not as a silent stall.
    const reducer = await api("/status?session=reducer2");
    expect(reducer.data.status).toBe("busy");
    expect(reducer.data.currentPrompt).toContain("offline and auto-start failed");
  });
});

describe("map partial timeout", () => {
  // Dedicated server with a short map timeout + fast watchdog so a stranded
  // shard is reaped within the test rather than after 30 minutes.
  const PT_DIR = "/tmp/haiflow-pool-pt-test";
  const PT_PORT = 9889;
  const PT_BASE = `http://localhost:${PT_PORT}`;
  let proc: ReturnType<typeof Bun.spawn>;

  async function ptApi(path: string, method = "GET", body?: object) {
    const res = await fetch(`${PT_BASE}${path}`, {
      method,
      headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  }

  beforeAll(async () => {
    if (existsSync(PT_DIR)) rmSync(PT_DIR, { recursive: true });
    mkdirSync(PT_DIR, { recursive: true });
    writeFileSync(`${PT_DIR}/pipeline.json`, JSON.stringify({
      topics: {}, emitters: {}, pools: { workers: { members: ["pw1", "pw2"] } },
    }));
    for (const s of ["pw1", "pw2", "pr"]) {
      const dir = `${PT_DIR}/${s}`;
      mkdirSync(`${dir}/responses`, { recursive: true });
      writeFileSync(`${dir}/session-id`, `claude-${s}`);
      writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "idle", since: new Date().toISOString() }));
    }
    // The fake tmux is a real spawned process per call, so every dispatch and
    // watchdog tick costs a few process starts. Keep the reap window (3s)
    // comfortably above that overhead: the point of this test is the partial
    // reduce itself, not shaving it to the fastest possible tick.
    proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
      env: {
        ...process.env,
        PATH: `${BIN_DIR}${PATH_SEP}${process.env.PATH}`,
        PORT: String(PT_PORT), HAIFLOW_DATA_DIR: PT_DIR,
        HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_GUARDRAILS: "false",
        HAIFLOW_MAP_TIMEOUT_SEC: "3", HAIFLOW_WATCHDOG_INTERVAL_MS: "500",
      },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${PT_BASE}/health`)).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Server failed to start");
  });

  afterAll(async () => {
    await stopServer(proc, PT_DIR);
  });

  test("reducer fires with '(no output)' when a shard never returns", async () => {
    const map = await ptApi("/map", "POST", {
      items: ["a", "b"],
      pool: "workers",
      mapTemplate: "do {{item}}",
      reduce: { session: "pr", promptTemplate: "merge:\n{{results}}" },
    });
    const runId = map.data.runId;

    // Only shard 0 (pw1) reports; pw2's shard never does.
    await ptApi("/hooks/stop", "POST", { session_id: "claude-pw1", last_assistant_message: "SHARD_A" });

    // Wait for the run to age past MAP_TIMEOUT_SEC and the watchdog to reap it.
    let reduced = false;
    for (let i = 0; i < 100; i++) {
      const run = await ptApi(`/map/${runId}`);
      if (run.data.reduced) { reduced = true; break; }
      await Bun.sleep(250);
    }
    expect(reduced).toBe(true);

    const reducer = await ptApi("/status?session=pr");
    expect(reducer.data.status).toBe("busy");
    expect(reducer.data.currentPrompt).toContain("SHARD_A");
    expect(reducer.data.currentPrompt).toContain("(no output)");
  }, 30000);
});

describe("pool auto-start of an offline member (real tmux + fake claude)", () => {
  // The flip side of "fail loudly": when an offline member CAN start, pool
  // dispatch brings it up and delivers the prompt — no dead end. The fake
  // claude stands in for the real CLI exactly as in consumer-lifecycle.test.ts.
  const AS_PORT = 9892;
  const AS_DIR = "/tmp/haiflow-pool-autostart-test";
  const AS_BIN_DIR = "/tmp/haiflow-pool-autostart-bin";
  const AS_BASE = `http://localhost:${AS_PORT}`;
  let proc: ReturnType<typeof Bun.spawn>;

  // This suite needs exactly one property to hold: a pane opened by a client
  // whose PATH sees AS_BIN_DIR must resolve `claude` to the shim there, never
  // to the real binary — no test may spawn that. So ASK the pane, in a throwaway
  // session, instead of reasoning about where its environment comes from.
  //
  // The reasoning is what used to be here, and it was both wrong and
  // unconditionally false. Wrong: tmux 3.5a gives the pane the environment of
  // the client that ran `new-session` (which is the haiflow server, whose PATH
  // does carry the shim), not the server's global environment. Unconditionally
  // false: it seeded that global environment with `tmux start-server`, and with
  // the default `exit-empty on` a server holding no sessions exits at once —
  // so the `show-environment` right after it always failed and this test never
  // ran anywhere, on any machine, since tmux 2.4.
  const AS_PROBE_SESSION = `haiflow-autostart-probe-${process.pid}`;
  const CAN_AUTOSTART = (() => {
    if (!HAS_TMUX) return false;
    const probeFile = `${AS_BIN_DIR}/where-is-claude.txt`;
    const env = { ...process.env, PATH: `${AS_BIN_DIR}${PATH_SEP}${process.env.PATH}` };
    try {
      installShim(AS_BIN_DIR, "claude", FAKE_CLAUDE);
      if (existsSync(probeFile)) rmSync(probeFile, { force: true });
      Bun.spawnSync(["tmux", "kill-session", "-t", AS_PROBE_SESSION], { env });
      const started = Bun.spawnSync(
        ["tmux", "new-session", "-d", "-s", AS_PROBE_SESSION, "-c", "/tmp",
         "sh", "-c", `command -v claude > ${probeFile} 2>&1; sleep 10`],
        { env },
      );
      if (started.exitCode !== 0) return false;
      let resolved = "";
      for (let i = 0; i < 60; i++) {
        if (existsSync(probeFile)) { resolved = readFileSync(probeFile, "utf8").trim(); break; }
        Bun.sleepSync(50);
      }
      return resolved.startsWith(AS_BIN_DIR);
    } catch {
      return false;
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", AS_PROBE_SESSION], { env });
    }
  })();

  async function asApi(path: string, method = "GET", body?: object) {
    const res = await fetch(`${AS_BASE}${path}`, {
      method,
      headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  }

  beforeAll(async () => {
    if (!CAN_AUTOSTART) return; // the single test below skips; nothing to set up
    Bun.spawnSync(["tmux", "kill-session", "-t", "as1"]);
    for (const dir of [AS_DIR, AS_BIN_DIR]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(AS_DIR, { recursive: true });
    installShim(AS_BIN_DIR, "claude", FAKE_CLAUDE);
    writeFileSync(`${AS_DIR}/pipeline.json`, JSON.stringify({
      topics: {}, emitters: {}, pools: { rescue: { members: ["as1"] } },
    }));
    // Deliberately NO session-id file: the SessionStart hook links the fake
    // claude's own id onto this unlinked, running session (a seeded id would
    // block that fallback and the start would time out unlinked).
    const dir = `${AS_DIR}/as1`;
    mkdirSync(`${dir}/responses`, { recursive: true });
    writeFileSync(`${dir}/state.json`, JSON.stringify({
      status: "offline", since: new Date().toISOString(), cwd: "/tmp", model: null,
    }));

    proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
      env: {
        ...process.env,
        PATH: `${AS_BIN_DIR}${PATH_SEP}${process.env.PATH}`,
        PORT: String(AS_PORT), HAIFLOW_PORT: String(AS_PORT),
        HAIFLOW_DATA_DIR: AS_DIR, HAIFLOW_API_KEY: TEST_API_KEY,
        HAIFLOW_GUARDRAILS: "false",
        // The pane inherits this environment (it is the client that opens the
        // session), so this reaches the fake claude. Its default 120ms turnaround
        // is shorter than the /status round trip that follows the dispatch: the
        // member could be back to idle before the test ever saw it busy. Widen
        // the processing window so "dispatch marked it busy" stays a real
        // assertion instead of a race the fast machine loses.
        FAKE_CLAUDE_DELAY_MS: "2000",
      },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${AS_BASE}/health`)).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Server failed to start");
  });

  afterAll(async () => {
    if (!CAN_AUTOSTART) return;
    try { await asApi("/session/stop", "POST", { session: "as1" }); } catch {}
    Bun.spawnSync(["tmux", "kill-session", "-t", "as1"]);
    await stopServer(proc, AS_DIR, AS_BIN_DIR);
  });

  test.skipIf(!CAN_AUTOSTART)("dispatch auto-starts an offline member and delivers the prompt", async () => {
    const res = await asApi("/pool/rescue/trigger", "POST", { prompt: "pool autostart payload", id: "as-1" });
    expect(res.status).toBe(200);
    expect(res.data.member).toBe("as1");
    expect(res.data.where).toBe("sent");

    const status = await asApi("/status?session=as1");
    expect(status.data.status).toBe("busy");
    expect(status.data.currentTaskId).toBe("as-1");

    // The fake claude processes the prompt and fires the Stop hook: the member
    // returns to idle and the response is captured — the full loop, not just
    // the start.
    let st = "";
    for (let i = 0; i < 150; i++) {
      st = (await asApi("/status?session=as1")).data.status;
      if (st === "idle") break;
      await Bun.sleep(100);
    }
    expect(st).toBe("idle");

    const resp = await asApi("/responses/as-1?session=as1");
    expect(resp.status).toBe(200);
    expect(resp.data.messages.join("")).toContain("pool autostart payload");
  }, 30000);
});
