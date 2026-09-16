// O arquivo do prompt grande morre com a TAREFA, nao por relogio.
//
// Medido em 16/09/2026 (SNAF, run `dba5dd0c`, turno 2 da investigacao do
// INC0311024): o prompt tinha ~156 KB em 444 linhas, varias acima de 5 KB. O
// Claude pagina um arquivo desse tamanho; o temporizador fixo de 60 s apagou o
// arquivo no meio da leitura, e a resposta foi:
//
//   "I can't complete this one -- the file was deleted out from under me
//    partway through reading it."
//
// O turno custou uma chamada Opus inteira e voltou sem JSON nenhum, derrubando
// junto a tentativa de reparo. Aqui o ciclo de vida e exercitado sem tmux e sem
// Claude: o que importa e QUEM apaga, e quando.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "fs";
import { join, delimiter } from "path";
import { SERVER_ENTRY, stopServer } from "./fixtures/server";
import { installShim } from "./fixtures/shim";

const FAKE_TMUX = join(import.meta.dir, "fixtures", "fake-tmux.ts");
const TEST_PORT = 9894;
const TEST_DIR = "/tmp/haiflow-prompt-file-test";
const BIN_DIR = `/tmp/haiflow-prompt-file-bin-${process.pid}`;
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;
const PATH_SEP = process.platform === "win32" ? ";" : ":";

let server: ReturnType<typeof Bun.spawn>;

const auth = { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" };
const PROMPT_GRANDE = "linha de instrucao ".repeat(500); // ~9 KB, bem acima do corte de 2 KB

function seedIdle(session: string, claudeId: string) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "idle", since: new Date().toISOString() }));
}

function estado(session: string): any {
  return JSON.parse(readFileSync(`${TEST_DIR}/${session}/state.json`, "utf-8"));
}

function arquivosDePrompt(): string[] {
  return readdirSync("/tmp").filter((f) => f.startsWith("haiflow-prompt-") && f.endsWith(".txt"));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true, force: true });
  installShim(BIN_DIR, "tmux", FAKE_TMUX);
  server = Bun.spawn([process.execPath, SERVER_ENTRY], {
    env: {
      ...process.env, PATH: `${BIN_DIR}${PATH_SEP}${process.env.PATH}`,
      PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_GUARDRAILS: "false",
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

describe("arquivo do prompt grande", () => {
  test("fica registrado no estado enquanto a tarefa roda, e some quando ela acaba", async () => {
    const session = "pf-ciclo";
    const claudeId = "claude-pf-ciclo";
    seedIdle(session, claudeId);
    const antes = arquivosDePrompt();

    const r = await fetch(`${BASE}/trigger`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ session, prompt: PROMPT_GRANDE }),
    });
    const { id } = await r.json();

    const arquivo = estado(session).currentPromptFile as string | undefined;
    expect(arquivo, "a tarefa tem de saber qual arquivo e o dela").toBeTruthy();
    expect(existsSync(arquivo!)).toBe(true);
    expect(readFileSync(arquivo!, "utf-8")).toBe(PROMPT_GRANDE);
    expect(arquivosDePrompt().length).toBe(antes.length + 1);

    // O Stop e o fim da tarefa -- e e ele que apaga.
    await fetch(`${BASE}/hooks/stop`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: claudeId, last_assistant_message: "pronto" }),
    });

    expect(existsSync(arquivo!)).toBe(false);
    expect(estado(session).currentPromptFile).toBeUndefined();
    expect(estado(session).status).toBe("idle");
    expect(id).toBeTruthy();
  });

  test("nao e apagado por relogio curto: sobrevive muito alem dos 60 s antigos", async () => {
    const session = "pf-relogio";
    seedIdle(session, "claude-pf-relogio");

    await fetch(`${BASE}/trigger`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ session, prompt: PROMPT_GRANDE }),
    });
    const arquivo = estado(session).currentPromptFile as string;

    // O controle negativo do defeito: com o timer fixo de 60 s, a unica coisa
    // que segurava o arquivo era o relogio. Aqui nada o apaga enquanto a tarefa
    // nao terminar -- o teste nao espera 60 s, ele prova que NINGUEM agendou a
    // remocao para antes do prazo da tarefa.
    await Bun.sleep(300);
    expect(existsSync(arquivo)).toBe(true);
    expect(estado(session).status).toBe("busy");

    // cancelar a tarefa tambem limpa
    const st = estado(session);
    await fetch(`${BASE}/tasks/${st.currentTaskId}/cancel?session=${session}`, { method: "POST", headers: auth });
    expect(existsSync(arquivo)).toBe(false);
  });

  test("prompt pequeno nao cria arquivo nenhum", async () => {
    const session = "pf-pequeno";
    seedIdle(session, "claude-pf-pequeno");
    const antes = arquivosDePrompt().length;

    await fetch(`${BASE}/trigger`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ session, prompt: "oi" }),
    });

    expect(estado(session).currentPromptFile).toBeUndefined();
    expect(arquivosDePrompt().length).toBe(antes);
  });
});

describe("varredura de boot", () => {
  test("nao apaga arquivo que uma sessao declara estar usando, por mais velho que seja", async () => {
    const { utimesSync } = await import("fs");
    const session = "pf-em-uso";
    seedIdle(session, "claude-pf-em-uso");

    await fetch(`${BASE}/trigger`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ session, prompt: PROMPT_GRANDE }),
    });
    const arquivo = estado(session).currentPromptFile as string;

    // Envelhece o arquivo muito alem da janela da varredura: o tmux sobrevive a
    // um restart do gateway, entao idade sozinha nao prova abandono -- e um
    // prompt grande, lido em paginas, fica velho ENQUANTO e usado.
    const velho = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(arquivo, velho, velho);

    const proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
      env: {
        ...process.env, PATH: `${BIN_DIR}${PATH_SEP}${process.env.PATH}`,
        PORT: String(TEST_PORT + 1), HAIFLOW_DATA_DIR: TEST_DIR,
        HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_GUARDRAILS: "false",
      },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`http://localhost:${TEST_PORT + 1}/health`)).ok) break; } catch {}
        await Bun.sleep(100);
      }
      expect(existsSync(arquivo), "a varredura levou o prompt de uma tarefa viva").toBe(true);
    } finally {
      await stopServer(proc);
    }
  });
});
