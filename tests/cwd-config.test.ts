import { test, expect, describe, afterAll, afterEach, beforeAll } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { installShim } from "./fixtures/shim";
import { SERVER_ENTRY, removeDirs, stopServer } from "./fixtures/server";

const TEST_API_KEY = "test-api-key";
const authHeaders: Record<string, string> = { "Authorization": `Bearer ${TEST_API_KEY}` };

// This file is about cwd ROUTING -- which cwd the gateway picks, and when it
// 400s. Nothing here wants a pane. With the real tmux on PATH the routing
// assertions still passed, but every accepted start ran for real:
//
//   - a name that matched no live session (`t5`, `t7`) got
//     `tmux new-session ... claude --permission-mode auto` -- a REAL Claude
//     Code session -- which then sat unlinked for START_READY_TIMEOUT_MS
//     (15s, hence the 17s these two took) before being killed. Two real
//     sessions per run, for a test that never looks at a pane.
//   - a name that DID match a live session took the reuse branch and read the
//     operator's own pane with `capture-pane`. Worse, had that pane happened
//     to show one of Claude's startup prompts, the code falls through to the
//     readiness loop and ends at `stopClaudeSession()` -- `tmux kill-session`
//     on a session this suite does not own.
//
// So: the fake tmux (tests/fixtures/fake-tmux.ts) goes first on the server's
// PATH, and the session names are unique per process. The fake reports every
// session as live, so starts take the reuse branch and return without ever
// resolving `claude`. Both are load-bearing -- the names alone would still
// spawn Claude, the fake alone would still be one failed shim install away
// from `t1`.
const FAKE_TMUX = join(import.meta.dir, "fixtures", "fake-tmux.ts");
const BIN_DIR = `/tmp/haiflow-cwd-test-bin-${process.pid}`;
const PATH_SEP = process.platform === "win32" ? ";" : ":";

// Session names that cannot collide with anything a human is running.
const S = (n: string) => `cwdcfg-${process.pid}-${n}`;

let nextPort = 9920;
let activeServer: ReturnType<typeof Bun.spawn> | null = null;
let activeDataDir: string | null = null;

async function startServer(extraEnv: Record<string, string>): Promise<{ base: string }> {
  const port = nextPort++;
  const dataDir = `/tmp/haiflow-cwd-test-${port}`;
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true });

  activeServer = Bun.spawn([process.execPath, SERVER_ENTRY], {
    // Run the server from a neutral dir so an omitted-cwd start (which resolves
    // to the fixed DEFAULT_CWD = "/tmp") fast-fails instead of linking a real
    // session in the repo root. The fallback value itself is always "/tmp".
    cwd: "/tmp",
    env: {
      ...process.env,
      PATH: `${BIN_DIR}${PATH_SEP}${process.env.PATH}`,
      PORT: String(port),
      HAIFLOW_DATA_DIR: dataDir,
      HAIFLOW_API_KEY: TEST_API_KEY,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  activeDataDir = dataDir;

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { base };
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Server on port ${port} failed to start`);
}

async function api(base: string, path: string, body?: object) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, data: ct.includes("json") ? await res.json() : await res.text() };
}

beforeAll(() => {
  if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true, force: true });
  installShim(BIN_DIR, "tmux", FAKE_TMUX);
});

afterEach(async () => {
  // kill() only signals. Without waiting for the exit the server is still
  // holding its data dir when the rm runs, and Windows answers EBUSY -- which
  // fails the test that had already passed its assertions.
  await stopServer(activeServer, activeDataDir);
  activeServer = null;
  activeDataDir = null;
});

afterAll(() => {
  removeDirs(BIN_DIR);
});

describe("session/start cwd config", () => {
  test("default: cwd is optional and falls back to /tmp", async () => {
    const { base } = await startServer({});
    const { status, data } = await api(base, "/session/start", { session: S("t1") });
    // cwd is optional now: a missing cwd no longer 400s, it defaults to /tmp.
    // tmux/claude may still 409 depending on host.
    expect(status).not.toBe(400);
    if (status === 200) {
      expect(data.cwdDefaulted).toBe(true);
      expect(data.cwd).toBe("/tmp");
    }
  });

  test("HAIFLOW_ALLOW_REQUEST_CWD=false rejects request that omits HAIFLOW_CWD on server", async () => {
    const { base } = await startServer({ HAIFLOW_ALLOW_REQUEST_CWD: "false" });
    const { status, data } = await api(base, "/session/start", { session: S("t2"), cwd: "/tmp" });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd from request is disabled; set HAIFLOW_CWD on the server");
  });

  test("HAIFLOW_ALLOW_REQUEST_CWD=false also rejects requests with no cwd at all", async () => {
    const { base } = await startServer({ HAIFLOW_ALLOW_REQUEST_CWD: "false" });
    const { status, data } = await api(base, "/session/start", { session: S("t3") });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd from request is disabled; set HAIFLOW_CWD on the server");
  });

  test("HAIFLOW_CWD set: request without cwd is accepted (uses forced cwd)", async () => {
    const { base } = await startServer({ HAIFLOW_CWD: "/tmp" });
    const { status, data } = await api(base, "/session/start", { session: S("t4") });
    // The cwd-validation gate must pass. tmux/claude may still fail with 409
    // depending on host setup — that is unrelated to env-var routing.
    expect(status).not.toBe(400);
    if (status === 200) expect(data.cwd).toBe("/tmp");
  });

  test("HAIFLOW_CWD set: request cwd is ignored, forced cwd wins", async () => {
    const { base } = await startServer({ HAIFLOW_CWD: "/tmp" });
    const { status, data } = await api(base, "/session/start", { session: S("t5"), cwd: "/var" });
    expect(status).not.toBe(400);
    if (status === 200) expect(data.cwd).toBe("/tmp");
  });

  test("HAIFLOW_CWD + HAIFLOW_ALLOW_REQUEST_CWD=false: forced cwd is used and request cwd ignored", async () => {
    const { base } = await startServer({ HAIFLOW_CWD: "/tmp", HAIFLOW_ALLOW_REQUEST_CWD: "false" });
    const { status, data } = await api(base, "/session/start", { session: S("t6"), cwd: "/var" });
    expect(status).not.toBe(400);
    if (status === 200) expect(data.cwd).toBe("/tmp");
  });

  test("HAIFLOW_ALLOW_REQUEST_CWD=true (explicit): cwd stays optional, defaults to /tmp", async () => {
    const { base } = await startServer({ HAIFLOW_ALLOW_REQUEST_CWD: "true" });
    const { status, data } = await api(base, "/session/start", { session: S("t7") });
    expect(status).not.toBe(400);
    if (status === 200) {
      expect(data.cwdDefaulted).toBe(true);
      expect(data.cwd).toBe("/tmp");
    }
  });
});
