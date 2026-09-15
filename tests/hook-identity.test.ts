// Identidade da sessao nos hooks.
//
// O defeito medido em 15/09/2026 (Falcon, fila de LLM do SNAF): 3 sessoes
// subiram em 0,4 s no mesmo cwd. O SessionStart ligava cada Claude a "primeira
// sessao sem id com tmux vivo", e os hooks passaram a cair na sessao errada:
//
// * `snaf-2ecb...` virou `busy` SEM tarefa no instante em que OUTRA sessao
//   recebeu o prompt; o /trigger dela foi para a fila e ninguem drenou -- o SNAF
//   leu "HaiFlow nunca entregou a tarefa (91 s)";
// * `snaf-f879...` executou ate o fim, mas o Stop nunca chegou nela: ficou
//   `busy`/`waiting` para sempre, com o "waiting for your input" de outro Claude.
//
// Aqui o nome da sessao viaja no header `X-Haiflow-Session` (posto pelo
// `hooks/forward.sh` a partir do `HAIFLOW_SESSION` do tmux) e cada teste monta
// o estado CRUZADO que a adivinhacao deixava. Sem a correcao, todos falham.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join, delimiter, resolve } from "path";
import { tmpdir } from "os";
import { SERVER_ENTRY, stopServer } from "./fixtures/server";
import { claudeSessionArgv, hookSessionFromHeaders } from "../src/utils";

function pathWithoutClaude(): string {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !exts.some((ext) => existsSync(join(dir, `claude${ext}`))))
    .join(delimiter);
}

const TEST_PORT = 9881;
const TEST_DIR = "/tmp/haiflow-test-hook-identity";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;
const auth = { Authorization: `Bearer ${TEST_API_KEY}` };

let server: ReturnType<typeof Bun.spawn>;

function seed(session: string, state: object, claudeId?: string) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/state.json`, JSON.stringify(state));
  if (claudeId) writeFileSync(`${dir}/session-id`, claudeId);
}

function linkedId(session: string): string | null {
  try { return readFileSync(`${TEST_DIR}/${session}/session-id`, "utf-8").trim() || null; } catch { return null; }
}

async function hook(path: string, body: object, session?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) headers["X-Haiflow-Session"] = session;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return res.json();
}

async function status(session: string) {
  const res = await fetch(`${BASE}/status?session=${session}`, { headers: auth });
  return res.json();
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  server = Bun.spawn([process.execPath, SERVER_ENTRY], {
    cwd: "/tmp",
    env: {
      ...process.env, PATH: pathWithoutClaude(), PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_START_READY_TIMEOUT_MS: "2000", HAIFLOW_GUARDRAILS: "false",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(async () => {
  await stopServer(server, TEST_DIR);
});

describe("o nome da sessao chega ao hook", () => {
  test("o tmux sobe o Claude com HAIFLOW_SESSION", () => {
    const argv = claudeSessionArgv("t", "/tmp", 3333, "snaf-abc-opus", "opus");
    expect(argv).toContain("HAIFLOW_SESSION=snaf-abc-opus");
    // `-e` antes do valor, e antes do `claude`: depois dele viraria argumento do CLI.
    const i = argv.indexOf("HAIFLOW_SESSION=snaf-abc-opus");
    expect(argv[i - 1]).toBe("-e");
    expect(i).toBeLessThan(argv.indexOf("claude"));
    expect(argv.slice(-2)).toEqual(["--model", "opus"]);
  });

  test("o header e saneado como nome de sessao, e vazio nao vale", () => {
    expect(hookSessionFromHeaders(new Headers({ "X-Haiflow-Session": "snaf-1/../x" }))).toBe("snaf-1x");
    expect(hookSessionFromHeaders(new Headers({ "X-Haiflow-Session": "../" }))).toBeNull();
    expect(hookSessionFromHeaders(new Headers())).toBeNull();
  });

  test("o forward.sh repassa HAIFLOW_SESSION no header", async () => {
    const bash = Bun.which("bash");
    const curl = Bun.which("curl");
    if (!bash || !curl) return; // sem bash/curl nao ha o que medir aqui
    let seen: string | null = "not-called";
    const probe = Bun.serve({
      port: 0,
      fetch(req) {
        seen = req.headers.get("x-haiflow-session");
        return new Response("{}");
      },
    });
    try {
      // Copia com LF: no checkout do Windows o autocrlf poe CRLF e o bash recusa.
      const script = join(tmpdir(), `forward-${process.pid}.sh`);
      writeFileSync(script, readFileSync(resolve(import.meta.dir, "..", "hooks", "forward.sh"), "utf-8").replace(/\r\n/g, "\n"));
      // Assincrono de proposito: o `probe` responde neste mesmo processo, e um
      // spawnSync seguraria o event loop com o curl esperando por ele.
      const run = async (session?: string) => {
        const proc = Bun.spawn([bash, script, "/hooks/stop"], {
          stdin: new Blob(["{}"]),
          env: { ...process.env, HAIFLOW: "1", HAIFLOW_PORT: String(probe.port), HAIFLOW_SESSION: session ?? "" },
        });
        await proc.exited;
      };
      await run("snaf-f879448da260-opus");
      expect(seen).toBe("snaf-f879448da260-opus");
      seen = "not-called";
      await run();
      expect(seen).toBeNull();
      rmSync(script, { force: true });
    } finally {
      probe.stop(true);
    }
  });
});

describe("hooks resolvidos pelo nome, nao pela adivinhacao", () => {
  test("SessionStart liga o Claude a sessao que ele declarou", async () => {
    seed("ident-a", { status: "offline", since: new Date().toISOString() });
    seed("ident-b", { status: "offline", since: new Date().toISOString() });

    const data = await hook("/hooks/session-start", { session_id: "claude-b" }, "ident-b");

    expect(data.session).toBe("ident-b");
    expect(linkedId("ident-b")).toBe("claude-b");
    expect(linkedId("ident-a")).toBeNull();
  });

  test("o prompt de um Claude marca a sessao dele, e desfaz a ligacao errada", async () => {
    // Estado que a adivinhacao deixou: o Claude "claude-x" roda no tmux de
    // ident-d, mas ficou ligado a ident-c.
    seed("ident-c", { status: "idle", since: new Date().toISOString() }, "claude-x");
    seed("ident-d", { status: "idle", since: new Date().toISOString() });

    await hook("/hooks/prompt", { session_id: "claude-x", prompt: "turno 1" }, "ident-d");

    expect((await status("ident-d")).status).toBe("busy");
    // Era aqui que a outra sessao virava busy sem tarefa e travava a propria fila.
    expect((await status("ident-c")).status).toBe("idle");
    expect(linkedId("ident-d")).toBe("claude-x");
    expect(linkedId("ident-c")).toBeNull();
  });

  test("o Stop grava a resposta na tarefa da sessao certa", async () => {
    // Ligacoes trocadas entre as duas sessoes, as duas executando.
    const since = new Date().toISOString();
    seed("ident-e", { status: "busy", since, currentTaskId: "task-e", currentPrompt: "E?" }, "claude-f");
    seed("ident-f", { status: "busy", since, currentTaskId: "task-f", currentPrompt: "F?" }, "claude-e");

    await hook("/hooks/stop", { session_id: "claude-f", last_assistant_message: "resposta de F" }, "ident-f");

    expect((await status("ident-f")).status).toBe("idle");
    const saved = JSON.parse(readFileSync(`${TEST_DIR}/ident-f/responses/task-f.json`, "utf-8"));
    expect(saved.messages).toEqual(["resposta de F"]);
    // A resposta de F nunca pode virar a resposta da tarefa de E.
    expect(existsSync(`${TEST_DIR}/ident-e/responses/task-e.json`)).toBe(false);
    expect((await status("ident-e")).status).toBe("busy");
  });

  test("header com sessao inexistente nao chuta outra dona", async () => {
    seed("ident-g", { status: "busy", since: new Date().toISOString(), currentTaskId: "task-g" });

    const data = await hook("/hooks/session-start", { session_id: "claude-z" }, "nao-existe");

    expect(data.session ?? null).toBeNull();
    expect(linkedId("ident-g")).toBeNull();
    expect(existsSync(`${TEST_DIR}/nao-existe`)).toBe(false);
  });

  test("sem header, segue a busca pelo id (tmux subido antes da correcao)", async () => {
    seed("ident-h", { status: "idle", since: new Date().toISOString() }, "claude-h");

    await hook("/hooks/prompt", { session_id: "claude-h", prompt: "legado" });

    expect((await status("ident-h")).status).toBe("busy");
  });
});
