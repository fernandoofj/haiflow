// CF-315 — "o modelo que roda tem de ser o modelo escolhido".
//
// O defeito medido em 18/08/2026: a sessão subia com
// `claude --permission-mode auto`, SEM `--model`, e nem `/session/start` nem
// `/trigger` aceitavam modelo. O `model_string` cadastrado no SNAF nunca saía
// do SNAF — a tela dizia `sonnet-5` e a sessão rodava `Opus 5 (1M context)`.
// Ninguém desobedecia: o pedido não era transmitido.
//
// Aqui ficam as duas peças testáveis sem tmux nem `claude` no PATH: a
// sanitização do modelo (que vira ARGUMENTO de linha de comando) e o limite do
// nome de sessão, que a CF-315 empurrou e que já estava estourando sozinho.

import { test, expect, describe } from "bun:test";
import { sanitizeModel, sanitizeSession, MAX_SESSION_NAME } from "../src/utils";

describe("sanitizeModel (CF-315)", () => {
  test("aceita os formatos que o claude aceita — alias e id completo", () => {
    expect(sanitizeModel("sonnet")).toBe("sonnet");
    expect(sanitizeModel("opus")).toBe("opus");
    expect(sanitizeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(sanitizeModel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1-20250805");
  });

  test("apara espaço em volta", () => {
    expect(sanitizeModel("  sonnet  ")).toBe("sonnet");
  });

  test("ausência vira null — é 'não escolheu', não erro", () => {
    expect(sanitizeModel(undefined)).toBeNull();
    expect(sanitizeModel(null)).toBeNull();
    expect(sanitizeModel("")).toBeNull();
    expect(sanitizeModel("   ")).toBeNull();
  });

  // O ponto de segurança da task. Não há shell no meio (Bun.spawnSync recebe
  // array), então o risco não é injeção de shell — é injeção de FLAG: um
  // "modelo" que começa com `-` chegaria ao claude como OPÇÃO, não como valor.
  test("RECUSA algo que viraria uma flag do claude", () => {
    expect(sanitizeModel("--dangerously-skip-permissions")).toBeNull();
    expect(sanitizeModel("-permission-mode")).toBeNull();
    expect(sanitizeModel("--model")).toBeNull();
  });

  test("recusa o que não é nome de modelo", () => {
    expect(sanitizeModel("sonnet; rm -rf /")).toBeNull();
    expect(sanitizeModel("sonnet 5")).toBeNull();
    expect(sanitizeModel("../../etc/passwd")).toBeNull();
    expect(sanitizeModel("$(whoami)")).toBeNull();
    expect(sanitizeModel(42)).toBeNull();
    expect(sanitizeModel({})).toBeNull();
  });

  test("recusa nome absurdamente longo", () => {
    expect(sanitizeModel("a".repeat(65))).toBeNull();
    expect(sanitizeModel("a".repeat(64))).toBe("a".repeat(64));
  });
});

describe("sanitizeSession: o limite que já estava estourando (CF-315)", () => {
  // O SNAF nomeia a sessão como `<run_id>-<stage>`. Este é um nome REAL, da
  // limpeza de 18/08/2026.
  const UUID = "04e81638-b621-407a-a044-47c9fec764fc";

  test("um nome real do SNAF batia exatamente no teto antigo de 64", () => {
    const nome = `${UUID}-architecture_contract_agent`;
    expect(nome.length).toBe(64);
  });

  test("e o stage seguinte JÁ passava — era isso que truncava", () => {
    const nome = `${UUID}-requirements_compiler-revision`;
    expect(nome.length).toBeGreaterThan(64);
    // Com o teto antigo, virava `...-revis` — foi assim que apareceu na lista
    // de sessões durante a limpeza.
    expect(nome.slice(0, 64).endsWith("-revis")).toBe(true);
  });

  test("dois nomes que só diferem DEPOIS do corte viravam a MESMA sessão", () => {
    // O risco real do truncamento: uma sessão do Claude compartilhada por duas
    // tarefas, com o contexto de uma vazando na outra.
    const a = `${UUID}-requirements_compiler-revision-1`;
    const b = `${UUID}-requirements_compiler-revision-2`;
    expect(a.slice(0, 64)).toBe(b.slice(0, 64));
    // Com o teto novo, deixam de colidir.
    expect(sanitizeSession(a)).not.toBe(sanitizeSession(b));
  });

  test("o teto novo cabe nome do SNAF + sufixo de modelo", () => {
    const comModelo = `${UUID}-architecture_contract_agent-sonnet`;
    expect(comModelo.length).toBeLessThanOrEqual(MAX_SESSION_NAME);
    expect(sanitizeSession(comModelo)).toBe(comModelo);
  });

  test("segue removendo caractere que não pode virar nome de tmux/diretório", () => {
    expect(sanitizeSession("a/b/../c")).toBe("abc");
    expect(sanitizeSession("")).toBe("default");
  });
});
