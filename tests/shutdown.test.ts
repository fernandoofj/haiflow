import { test, expect, describe, afterAll } from "bun:test";
import { writeFileSync, rmSync } from "fs";
import { SERVER_ENTRY, removeDirs, stopServer } from "./fixtures/server";

const TEST_PORT = 9912;
const TEST_DIR = "/tmp/haiflow-shutdown-test";
const BASE = `http://localhost:${TEST_PORT}`;

// Can a spawned child on THIS runtime run its own SIGTERM handler at all?
//
// The question is asked, not assumed. The probe is the smallest program that
// could answer it: a child that installs a handler, prints when it fires, and
// exits 0. If `HANDLER_RAN` comes back the platform delivers the signal to
// user code and the test below is meaningful; if the child instead dies at 143
// (128 + SIGTERM), no handler on this platform can produce a clean exit and
// the test is measuring the OS, not haiflow.
//
// Windows is where that happens today: it has no POSIX signals, so Bun's
// `proc.kill("SIGTERM")` terminates the process outright — measured here at
// exit 143 with the handler never reached (SIGINT is the same story at 130).
// The graceful-shutdown path itself is fine; it is simply unreachable from a
// signal on this host. Probing rather than checking `process.platform` means
// the test comes back on its own the day the runtime can deliver it.
const SIGTERM_PROBE = `/tmp/haiflow-sigterm-probe-${process.pid}.ts`;
const SIGTERM_DELIVERABLE = await (async () => {
  try {
    writeFileSync(
      SIGTERM_PROBE,
      'process.on("SIGTERM", () => { console.log("HANDLER_RAN"); process.exit(0); });\n'
        + 'setInterval(() => {}, 1000);\n'
        + 'console.log("READY");\n',
    );
    const proc = Bun.spawn([process.execPath, SIGTERM_PROBE], { stdout: "pipe", stderr: "ignore" });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    const deadline = Date.now() + 10_000;
    while (!out.includes("READY") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    proc.kill("SIGTERM");
    const code = await proc.exited;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
    } catch {}
    return code === 0 && out.includes("HANDLER_RAN");
  } catch {
    return false;
  } finally {
    try { rmSync(SIGTERM_PROBE, { force: true }); } catch {}
  }
})();

afterAll(() => {
  removeDirs(TEST_DIR);
});

describe("graceful shutdown", () => {
  test.skipIf(!SIGTERM_DELIVERABLE)("exits cleanly (code 0) on SIGTERM", async () => {
    removeDirs(TEST_DIR);

    // Absolute entry via the running bun binary: `bun run` interposes a
    // launcher, and the signal would go to the launcher rather than to the
    // server whose handler is under test.
    const proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HAIFLOW_DATA_DIR: TEST_DIR,
        HAIFLOW_API_KEY: "shutdown-test-key",
        HAIFLOW_GUARDRAILS: "false",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          const res = await fetch(`${BASE}/health`);
          if (res.ok) { ready = true; break; }
        } catch {}
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);

      // Without the SIGTERM handler the process is killed by the signal and
      // never reaches a clean exit. The handler clears timers, stops the server
      // and closes Redis, then exits 0.
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      // Wait for the exit before afterAll's rm: a live server holds TEST_DIR
      // open and the removal fails with EBUSY on Windows.
      await stopServer(proc);
    }
  });
});
