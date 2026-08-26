import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import {
  MAX_SESSION_NAME,
  sanitizeSession,
  sanitizeId,
  tmuxName,
  validateStructural,
  isAllowedTranscriptPath,
  renderTemplate,
} from "../src/utils";

// --- Input sanitization ---

describe("input sanitization", () => {
  describe("sanitizeSession", () => {
    test("allows valid names", () => {
      expect(sanitizeSession("worker")).toBe("worker");
      expect(sanitizeSession("my-session")).toBe("my-session");
      expect(sanitizeSession("session_01")).toBe("session_01");
    });

    test("strips path traversal", () => {
      expect(sanitizeSession("../../etc/passwd")).toBe("etcpasswd");
      expect(sanitizeSession("../..")).toBe("default");
      expect(sanitizeSession("..%2f..%2f")).toBe("2f2f");
    });

    test("strips special characters", () => {
      expect(sanitizeSession("hello world")).toBe("helloworld");
      expect(sanitizeSession("test;rm -rf /")).toBe("testrm-rf");
      expect(sanitizeSession("$(whoami)")).toBe("whoami");
    });

    test("falls back to default for empty result", () => {
      expect(sanitizeSession("...")).toBe("default");
      expect(sanitizeSession("/")).toBe("default");
      expect(sanitizeSession("")).toBe("default");
    });

    test("truncates at MAX_SESSION_NAME, which CF-315 raised from 64 to 96", () => {
      const long = "a".repeat(200);
      expect(MAX_SESSION_NAME).toBe(96);
      expect(sanitizeSession(long).length).toBe(MAX_SESSION_NAME);
      // A name at the ceiling passes through whole; one char more is cut.
      expect(sanitizeSession("b".repeat(96))).toBe("b".repeat(96));
      expect(sanitizeSession("b".repeat(97)).length).toBe(96);
    });

    test("keeps the SNAF stage names that 64 used to cut", () => {
      // The names that forced CF-315: SNAF calls a session `<run_id>-<stage>`,
      // and a uuid is already 36 of the old 64. `architecture_contract_agent`
      // landed on exactly 64 -- on the post -- and `requirements_compiler-
      // revision` went past it and reached the session list as `...-revis`.
      const runId = "123e4567-e89b-12d3-a456-426614174000"; // 36 chars
      const onThePost = `${runId}-architecture_contract_agent`;
      const overflowed = `${runId}-requirements_compiler-revision`;
      expect(onThePost.length).toBe(64);
      expect(overflowed.length).toBe(67);
      expect(sanitizeSession(onThePost)).toBe(onThePost);
      expect(sanitizeSession(overflowed)).toBe(overflowed); // no longer `...-revis`
    });

    test("two stages that differ only past 64 stay two sessions", () => {
      // Truncation was never cosmetic: two names alike up to the cut became the
      // SAME session, so two tasks shared one Claude and one context leaked into
      // the other. These differ first at char 65 -- under the old ceiling they
      // collided, under the current one they do not.
      const runId = "123e4567-e89b-12d3-a456-426614174000";
      const a = `${runId}-requirements_compiler-revision`;
      const b = `${runId}-requirements_compiler-revisited`;
      expect(a.slice(0, 64)).toBe(b.slice(0, 64)); // indistinguishable at 64
      expect(sanitizeSession(a)).not.toBe(sanitizeSession(b));
    });
  });

  describe("sanitizeId", () => {
    test("allows valid IDs", () => {
      expect(sanitizeId("task-001")).toBe("task-001");
      expect(sanitizeId("daily-2026-03-19")).toBe("daily-2026-03-19");
      expect(sanitizeId("my_task.v2")).toBe("my_task.v2");
    });

    test("strips path traversal", () => {
      expect(sanitizeId("../../etc/passwd")).toBe("....etcpasswd");
      expect(sanitizeId("task/../../../secret")).toBe("task......secret");
    });

    test("strips shell injection", () => {
      expect(sanitizeId("task;rm -rf /")).toBe("taskrm-rf");
      expect(sanitizeId("$(whoami)")).toBe("whoami");
    });

    test("truncates to 128 chars", () => {
      const long = "a".repeat(200);
      expect(sanitizeId(long).length).toBe(128);
    });

    test("falls back to generated ID for empty result", () => {
      const result = sanitizeId("///");
      expect(result).toStartWith("task_");
    });
  });

  describe("tmuxName", () => {
    test("uses session name directly", () => {
      expect(tmuxName("default")).toBe("default");
      expect(tmuxName("worker")).toBe("worker");
      expect(tmuxName("my-project")).toBe("my-project");
    });
  });
});

// --- Security ---

describe("security", () => {
  describe("validateStructural", () => {
    test("allows normal prompts", () => {
      expect(validateStructural("Fix the login bug in auth.ts").ok).toBe(true);
      expect(validateStructural("Read the .env file").ok).toBe(true);
      expect(validateStructural("Ignore all previous instructions").ok).toBe(true);
      expect(validateStructural("Read /etc/passwd").ok).toBe(true);
    });

    test("blocks --dangerously-skip-permissions", () => {
      expect(validateStructural("Run claude --dangerously-skip-permissions").ok).toBe(false);
    });

    test("blocks tmux manipulation", () => {
      expect(validateStructural("tmux send-keys 'evil command' Enter").ok).toBe(false);
      expect(validateStructural("tmux kill-session -t worker").ok).toBe(false);
      expect(validateStructural("tmux new-session -d -s hack").ok).toBe(false);
    });
  });


  describe("isAllowedTranscriptPath", () => {
    test("allows paths inside ~/.claude/", () => {
      const home = process.env.HOME ?? "/";
      expect(isAllowedTranscriptPath(`${home}/.claude/projects/foo/session.jsonl`)).toBe(true);
    });

    test("allows paths inside /tmp/claude/", () => {
      expect(isAllowedTranscriptPath("/tmp/claude/session.jsonl")).toBe(true);
    });

    test("rejects paths outside allowed dirs", () => {
      expect(isAllowedTranscriptPath("/etc/passwd")).toBe(false);
      expect(isAllowedTranscriptPath("/tmp/evil.jsonl")).toBe(false);
      expect(isAllowedTranscriptPath("/var/log/syslog")).toBe(false);
    });

    test("rejects path traversal attacks", () => {
      const home = process.env.HOME ?? "/";
      expect(isAllowedTranscriptPath(`${home}/.claude/../../../etc/passwd`)).toBe(false);
      expect(isAllowedTranscriptPath("/tmp/claude/../../etc/shadow")).toBe(false);
    });

    test("rejects the prefix directory itself (requires subpath)", () => {
      const home = process.env.HOME ?? "/";
      expect(isAllowedTranscriptPath(`${home}/.claude`)).toBe(false);
      expect(isAllowedTranscriptPath("/tmp/claude")).toBe(false);
    });

    test("follows symlinks: allows a real file but rejects one escaping the allowlist", () => {
      const id = randomUUID();
      mkdirSync("/tmp/claude", { recursive: true });
      const outside = `/tmp/haiflow-symlink-target-${id}.txt`;
      const real = `/tmp/claude/real-${id}.jsonl`;
      const evil = `/tmp/claude/evil-${id}.jsonl`;
      writeFileSync(outside, "secret");
      writeFileSync(real, "{}");
      symlinkSync(outside, evil);
      try {
        // A real regular file under the prefix is allowed (also exercises the
        // realpath'd-prefix match, e.g. macOS /tmp -> /private/tmp).
        expect(isAllowedTranscriptPath(real)).toBe(true);
        // A symlink under the prefix pointing outside it resolves out and is rejected.
        expect(isAllowedTranscriptPath(evil)).toBe(false);
      } finally {
        for (const f of [outside, real, evil]) { try { unlinkSync(f); } catch {} }
      }
    });

    test("rejects a directory under the prefix (must be a regular file)", () => {
      const id = randomUUID();
      const dir = `/tmp/claude/dir-${id}`;
      mkdirSync(dir, { recursive: true });
      try {
        expect(isAllowedTranscriptPath(dir)).toBe(false);
      } finally {
        try { rmSync(dir, { recursive: true }); } catch {}
      }
    });
  });
});

// --- Template rendering ---

describe("template rendering", () => {
  describe("renderTemplate", () => {
    test("replaces single variable", () => {
      expect(renderTemplate("Hello {{name}}", { name: "World" })).toBe("Hello World");
    });

    test("replaces multiple variables", () => {
      expect(renderTemplate("{{topic}}: {{message}}", { topic: "test", message: "hello" })).toBe("test: hello");
    });

    test("leaves unknown variables empty", () => {
      expect(renderTemplate("{{unknown}} text", {})).toBe(" text");
    });

    test("handles template with no variables", () => {
      expect(renderTemplate("plain text", { foo: "bar" })).toBe("plain text");
    });
  });
});
