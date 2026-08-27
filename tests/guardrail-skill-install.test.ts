import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";
import { SERVER_ENTRY, removeDirs, stopServer } from "./fixtures/server";

const TEST_PORT = 9893;
const TEST_DIR = "/tmp/haiflow-skill-install-test";
const FAKE_HOME = `${TEST_DIR}/home`;
const SKILL_PATH = `${FAKE_HOME}/.claude/skills/haiflow-guardrails/SKILL.md`;
const BACKUP_PATH = `${SKILL_PATH}.bak`;

const TEMPLATE = readFileSync(
  resolve(import.meta.dir, "../src/skills/haiflow-guardrails.md"),
  "utf8",
);

/** Boot a server with guardrails ON and a HOME of our own, then stop it. */
async function bootOnce(): Promise<void> {
  const proc = Bun.spawn([process.execPath, SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: `${TEST_DIR}/data`,
      HAIFLOW_API_KEY: "skill-install-test-key",
      HAIFLOW_GUARDRAILS: "true",
      HOME: FAKE_HOME,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`http://localhost:${TEST_PORT}/health`)).ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Server failed to start");
  } finally {
    await stopServer(proc);
  }
}

afterAll(() => {
  removeDirs(TEST_DIR);
});

// The server installs its guardrail skill into ~/.claude/skills at boot. That
// is by design -- a skill only loads from there, and shipping the template with
// the server is what keeps the two from drifting. What was wrong was doing it
// blind: the write happened on every boot, over anything already there, with no
// way for whoever opened the file to know it was managed.
describe("guardrail skill install", () => {
  test("primeira subida escreve o arquivo, e ele se declara gerado", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(FAKE_HOME, { recursive: true });

    await bootOnce();

    expect(existsSync(SKILL_PATH)).toBe(true);
    const escrito = readFileSync(SKILL_PATH, "utf8");
    expect(escrito).toBe(TEMPLATE);
    // Sem esta marca, quem abrisse o arquivo nao teria como saber que a proxima
    // subida o reescreve -- e e ela que distingue nossa copia de uma escrita a mao.
    expect(escrito).toContain("<!-- generated-by: haiflow");
  }, 30000);

  test("subir de novo com o mesmo conteudo nao toca no arquivo", async () => {
    const antes = statSync(SKILL_PATH).mtimeMs;
    // Recuar o mtime: sem isso, um relogio de baixa resolucao poderia devolver
    // o mesmo valor para uma reescrita real e o teste passaria por acidente.
    const passado = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("fs");
    utimesSync(SKILL_PATH, passado, passado);
    const recuado = statSync(SKILL_PATH).mtimeMs;
    expect(recuado).toBeLessThan(antes);

    await bootOnce();

    expect(statSync(SKILL_PATH).mtimeMs).toBe(recuado);
    expect(readFileSync(SKILL_PATH, "utf8")).toBe(TEMPLATE);
  }, 30000);

  test("copia escrita a mao vai para .bak em vez de sumir", async () => {
    const meu = "---\nname: haiflow-guardrails\n---\n\n# regra minha, escrita a mao\n";
    writeFileSync(SKILL_PATH, meu);
    if (existsSync(BACKUP_PATH)) rmSync(BACKUP_PATH);

    await bootOnce();

    // O arquivo sem a marca nao e nosso. Ele para de valer -- isso e inevitavel,
    // o servidor precisa da sua versao -- mas nao pode sumir calado.
    expect(existsSync(BACKUP_PATH)).toBe(true);
    expect(readFileSync(BACKUP_PATH, "utf8")).toBe(meu);
    expect(readFileSync(SKILL_PATH, "utf8")).toBe(TEMPLATE);
  }, 30000);
});
