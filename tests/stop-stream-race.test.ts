// The Stop hook must not race the message-display stream (2026-08-20).
//
// Measured on session snaf-5ab706a65145-opus, task lc-0875b3b7: the response
// was saved at 19:22:51.206Z while the final message's deltas kept arriving
// until .229 — the transcript pass ran on a transcript that did not yet hold
// the final message, and the saved response was the one-line preamble instead
// of the 34KB JSON the model actually wrote. The caller's schema validation
// then failed against prose, twice in one afternoon.
//
// The contract under test: (1) Stop waits for the display stream's final
// delta before mining; (2) a streamed message the transcript pass missed is
// merged in; (3) a stream that never closes becomes an `error` record —
// a clean failure to retry, never a truncated answer passed off as real.
//
// The server runs with HAIFLOW_STOP_STREAM_WAIT_MS=500 so the discard case
// costs half a second, not the production 3s.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, appendFileSync } from "fs";
import { resolve } from "path";

const SERVER_ENTRY = resolve(import.meta.dir, "../src/index.ts");

const TEST_PORT = 9893;
const TEST_DIR = "/tmp/haiflow-stop-race-test";
const TRANSCRIIPT_DIR = "/tmp/claude/stop-race-fixtures";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;
const WAIT_MS = 2000;

let server: ReturnType<typeof Bun.spawn>;

async function hook(path: string, body: object) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// One session per test: its own claude id, state and transcript, so the cases
// cannot see each other's deltas.
function prepareSession(name: string, taskId: string): { claudeId: string; transcript: string } {
  const claudeId = `claude-${name}`;
  const dir = `${TEST_DIR}/${name}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify({
    status: "working", since: new Date().toISOString(), session: name,
    currentTaskId: taskId, currentPrompt: "compile the spec",
  }));
  const transcript = `${TRANSCRIIPT_DIR}/${name}.jsonl`;
  return { claudeId, transcript };
}

// Claude Code transcript lines, the shape extractFromTranscript mines: a user
// prompt to anchor the task window, then assistant text blocks.
function writeTranscript(path: string, texts: string[]) {
  const lines = [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "compile the spec" }] } }),
    ...texts.map((text) => JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-5", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } },
    })),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
}

function savedResponse(name: string, taskId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${TEST_DIR}/${name}/responses/${taskId}.json`, "utf-8"));
}

async function postDelta(claudeId: string, messageId: string, index: number, delta: string, final: boolean) {
  const res = await hook("/hooks/message-display", {
    session_id: claudeId, message_id: messageId, index, delta, final,
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  for (const dir of [TEST_DIR, TRANSCRIIPT_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
  }
  server = Bun.spawn(["bun", "run", SERVER_ENTRY], {
    cwd: "/tmp",
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_START_READY_TIMEOUT_MS: "2000",
      HAIFLOW_GUARDRAILS: "false",
      HAIFLOW_STOP_STREAM_WAIT_MS: String(WAIT_MS),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(() => {
  server?.kill();
  for (const dir of [TEST_DIR, TRANSCRIIPT_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
});

// --- 1. the merge: a streamed message the transcript pass missed ------------

test("a message the transcript missed is merged from the display buffer", async () => {
  const taskId = "lc-merge";
  const { claudeId, transcript } = prepareSession("merge", taskId);

  // The turn as the stream saw it: narration, then the JSON — both closed.
  await postDelta(claudeId, "msg-a", 0, "Now I'll compile the spec.", true);
  await postDelta(claudeId, "msg-b", 0, '{"schema_version": "1.0", ', false);
  await postDelta(claudeId, "msg-b", 1, '"item": "REQ-ITEM-001"}', true);

  // The transcript as the race left it: only the narration flushed.
  writeTranscript(transcript, ["Now I'll compile the spec."]);

  const res = await hook("/hooks/stop", { session_id: claudeId, transcript_path: transcript });
  expect(res.status).toBe(200);

  const saved = savedResponse("merge", taskId);
  expect(saved.error).toBeUndefined();
  const joined = (saved.messages as string[]).join("\n\n");
  expect(joined).toContain("Now I'll compile the spec.");
  // The point of the whole fix: the JSON is not lost.
  expect(joined).toContain('"schema_version": "1.0"');
  expect(joined).toContain('"item": "REQ-ITEM-001"');
});

// --- 2. the discard: a stream that never closes is an error, not an answer --

test("a stream that never closes becomes an error record after the wait", async () => {
  const taskId = "lc-discard";
  const { claudeId, transcript } = prepareSession("discard", taskId);

  await postDelta(claudeId, "msg-c", 0, '{"schema_version": "1.0", "item":', false); // never final
  writeTranscript(transcript, ["Let me compile it."]);

  const before = Date.now();
  const res = await hook("/hooks/stop", { session_id: claudeId, transcript_path: transcript });
  expect(res.status).toBe(200);
  // It genuinely waited for the stream before giving up.
  expect(Date.now() - before).toBeGreaterThanOrEqual(WAIT_MS - 50);

  const saved = savedResponse("discard", taskId);
  expect(saved.error).toBe("incomplete_stream");
  // The partial text is kept for forensics, flagged — never passed off clean.
  expect((saved.messages as string[]).join("")).toContain("Let me compile it.");
});

// --- 3. the wait: a final delta arriving mid-wait resolves normally ---------

test("a final delta arriving during the wait produces a normal save", async () => {
  const taskId = "lc-late";
  const { claudeId, transcript } = prepareSession("late", taskId);

  await postDelta(claudeId, "msg-d", 0, '{"late": ', false);
  writeTranscript(transcript, ["Almost there."]);

  const stopPromise = hook("/hooks/stop", { session_id: claudeId, transcript_path: transcript });
  await Bun.sleep(150);
  await postDelta(claudeId, "msg-d", 1, '"but complete"}', true);

  const res = await stopPromise;
  expect(res.status).toBe(200);
  const saved = savedResponse("late", taskId);
  expect(saved.error).toBeUndefined();
  expect((saved.messages as string[]).join("\n\n")).toContain('{"late": "but complete"}');
});

// --- 4. regression guard: no deltas means no wait and no behavior change ----

test("a task with no display deltas saves immediately, as before", async () => {
  const taskId = "lc-plain";
  const { claudeId, transcript } = prepareSession("plain", taskId);
  writeTranscript(transcript, ["Plain answer, no streaming hook configured."]);

  const before = Date.now();
  const res = await hook("/hooks/stop", { session_id: claudeId, transcript_path: transcript });
  expect(res.status).toBe(200);
  // Bem abaixo de WAIT_MS, com folga para o overhead fixo do request (~600ms
  // medido no container): o que este teste recusa e a espera INTEIRA ser paga
  // por um turno que nem tem stream.
  expect(Date.now() - before).toBeLessThan(WAIT_MS - 500);

  const saved = savedResponse("plain", taskId);
  expect(saved.error).toBeUndefined();
  expect((saved.messages as string[]).join("")).toContain("Plain answer");
});
