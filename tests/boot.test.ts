import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync, unlinkSync, utimesSync } from "fs";
import { randomUUID } from "crypto";
import { SERVER_ENTRY, removeDirs, stopServer } from "./fixtures/server";

const TEST_DIR = "/tmp/haiflow-boot-test";
const PORT = 9888;

afterAll(() => {
  removeDirs(TEST_DIR);
});

describe("startup prompt-file sweep", () => {
  test("removes stale prompt files but keeps in-flight (recent) ones", async () => {
    // Stale leftover from a crashed run: backdate its mtime past the 120s window.
    const stale = `/tmp/haiflow-prompt-${randomUUID()}.txt`;
    writeFileSync(stale, "stale large-prompt contents");
    const old = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(stale, old, old);

    // A just-written prompt belonging to a concurrent/restarting instance must
    // NOT be swept (it's still inside its 60s read window).
    const fresh = `/tmp/haiflow-prompt-${randomUUID()}.txt`;
    writeFileSync(fresh, "in-flight large-prompt contents");

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
      env: {
        ...process.env, PORT: String(PORT), HAIFLOW_DATA_DIR: TEST_DIR,
        HAIFLOW_API_KEY: "boot-test-key", HAIFLOW_GUARDRAILS: "false",
      },
      stdout: "ignore", stderr: "ignore",
    });

    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { ready = true; break; } } catch {}
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);
      // The boot sweep runs during module init, before /health responds.
      expect(existsSync(stale)).toBe(false); // stale -> reaped
      expect(existsSync(fresh)).toBe(true);  // in-flight -> preserved
    } finally {
      // Wait for the exit before afterAll's rm: a still-live server holds
      // TEST_DIR open and Windows answers the rm with EBUSY.
      await stopServer(proc);
      for (const f of [stale, fresh]) { try { unlinkSync(f); } catch {} }
    }
  });
});
