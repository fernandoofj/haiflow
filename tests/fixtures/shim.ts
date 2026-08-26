import { mkdirSync, writeFileSync, chmodSync, existsSync, statSync, linkSync, copyFileSync, rmSync } from "fs";
import { basename, join, resolve } from "path";

// Where compiled Windows shims are cached between runs (see below). resolve()d
// because `bun build --outfile` takes the path as given: on Windows a bare
// "/tmp/..." is not anchored to a drive and the build fails with EINVAL.
const CACHE_DIR = resolve("/tmp/haiflow-shim-cache");

// On Windows a `.cmd` shim is a dead end for this suite: Bun (like Node, since
// CVE-2024-27980) refuses to pass an argument containing a cmd.exe
// metacharacter to a .bat/.cmd file, and haiflow hands whole multi-line prompts
// to `tmux send-keys -l`. The first newline turns the call into a thrown
// ERR_INVALID_ARG_VALUE, which surfaced as an unrelated 500 from POST /map.
//
// So on Windows the fixture is compiled into a real executable instead. It is
// the same fixture source either way -- only the wrapper differs.
//
// Compiling costs ~0.5s and ~85MB, so the result is cached under CACHE_DIR and
// keyed by the fixture's mtime: an edited fixture rebuilds, an unchanged one is
// hardlinked into place (copied when a link is not possible).
function installWindowsShim(binDir: string, name: string, target: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, `${basename(target, ".ts")}-${statSync(target).mtimeMs}.exe`);
  if (!existsSync(cached)) {
    const build = Bun.spawnSync([process.execPath, "build", target, "--compile", "--outfile", cached], {
      stdout: "pipe", stderr: "pipe",
    });
    if (build.exitCode !== 0) {
      throw new Error(`failed to compile the ${name} shim from ${target}: ${build.stderr.toString()}`);
    }
  }
  const dest = join(binDir, `${name}.exe`);
  if (existsSync(dest)) rmSync(dest, { force: true });
  try {
    linkSync(cached, dest);
  } catch {
    copyFileSync(cached, dest);
  }
}

// Expose an executable double on PATH under `name`, so a server spawned with
// binDir first on its PATH resolves `name` to `target` instead of the real
// binary. POSIX gets an `sh` shim; Windows gets a compiled executable.
//
// Both forms run the fixture with the absolute path of the bun that is running
// the tests, so resolution never depends on the spawned process' own PATH.
export function installShim(binDir: string, name: string, target: string): void {
  mkdirSync(binDir, { recursive: true });
  const sh = join(binDir, name);
  writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(target)} "$@"\n`);
  chmodSync(sh, 0o755);
  if (process.platform === "win32") installWindowsShim(binDir, name, target);
}
