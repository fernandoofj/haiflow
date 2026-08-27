import { existsSync, rmSync } from "fs";
import { resolve } from "path";

/**
 * How every suite in here must spawn and stop a haiflow server.
 *
 * Two rules, both learned from the same class of red:
 *
 * 1. Spawn the ABSOLUTE entry with the bun binary that is running the tests --
 *    `Bun.spawn([process.execPath, SERVER_ENTRY])` -- never `bun run src/...`.
 *    `bun run <entry>` interposes a launcher process, so the handle the test
 *    keeps belongs to the launcher, not to the server. Killing it reaps the
 *    launcher and leaves the real server alive: still listening on the port the
 *    next file wants, and still holding its data dir open. The relative path is
 *    a second, quieter bug -- it only resolves while the cwd happens to be the
 *    repo root.
 *
 * 2. Stop it with `stopServer`, never a bare `proc.kill()`. `kill()` only
 *    signals; the process is still alive when the next line runs. On Windows an
 *    open handle in a directory makes `rmSync` throw EBUSY, so the teardown
 *    fails and takes an otherwise-green test down with it.
 */

// The server's own entry point, absolute, so the spawn does not depend on cwd.
export const SERVER_ENTRY = resolve(import.meta.dir, "..", "..", "src", "index.ts");

/**
 * Remove test directories, tolerating the brief window in which the OS still
 * holds a handle the exited process left behind (Windows: EBUSY / EPERM).
 * `force` swallows a missing path; the retries cover the racing handle.
 */
export function removeDirs(...dirs: (string | null | undefined)[]): void {
  for (const dir of dirs) {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}

/**
 * Kill a spawned server, WAIT until it is really gone, and only then remove the
 * directories it was holding. The await is the load-bearing part: without it
 * the rm races a live process and Windows answers EBUSY.
 */
export async function stopServer(
  proc: ReturnType<typeof Bun.spawn> | undefined | null,
  ...dirs: (string | null | undefined)[]
): Promise<void> {
  proc?.kill();
  await proc?.exited;
  removeDirs(...dirs);
}
