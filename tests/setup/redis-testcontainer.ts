/**
 * Preload do `bun test`: garante um Redis alcancavel para a suite.
 *
 * Ordem de decisao (a primeira que casar vence):
 *   1. REDIS_URL ja veio do ambiente  -> usa esse, NAO sobe container nenhum.
 *      (e o caso do GitHub Actions, que ja provisiona `services: redis:7`.)
 *   2. Existe Redis respondendo PING em 127.0.0.1:6379 -> usa o local.
 *   3. Docker disponivel -> sobe um `redis:7` descartavel, porta efemera
 *      presa em loopback, nome unico; exporta REDIS_URL; derruba no fim.
 *   4. Nada disso -> marca a suite como "sem Redis". Os testes que exigem
 *      Redis PULAM com motivo explicito, em vez de falharem vermelho.
 *
 * Contrato exportado para os testes (via env, lido por tests/setup/redis.ts):
 *   HAIFLOW_TEST_REDIS         "1" (ha Redis) | "0" (nao ha)
 *   HAIFLOW_TEST_REDIS_REASON  motivo legivel quando "0"
 *
 * O container NAO e reaproveitado entre rodadas: nome unico por processo e
 * `docker rm -f` no encerramento (afterAll + process exit + sinais), para nao
 * deixar lixo mesmo quando a suite quebra no meio.
 */

const IMAGE = process.env.HAIFLOW_TEST_REDIS_IMAGE ?? "redis:7";
const DEFAULT_LOCAL = "redis://127.0.0.1:6379";
const READY_TIMEOUT_MS = 30_000;

function note(msg: string) {
  console.error(`[haiflow-test/redis] ${msg}`);
}

/** PING de verdade: porta aberta nao prova que do outro lado ha um Redis. */
async function redisPing(url: string, timeoutMs = 1_500): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port || 6379);
  if (!Number.isFinite(port) || port <= 0) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, sock?: { end(): void }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({
      hostname,
      port,
      socket: {
        open(sock) {
          sock.write("PING\r\n");
        },
        data(sock, buf) {
          finish(new TextDecoder().decode(buf).includes("PONG"), sock);
        },
        error() {
          finish(false);
        },
        close() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  try {
    const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return {
      ok: res.exitCode === 0,
      out: res.stdout.toString().trim(),
      err: res.stderr.toString().trim(),
    };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}

function markUnavailable(reason: string) {
  process.env.HAIFLOW_TEST_REDIS = "0";
  process.env.HAIFLOW_TEST_REDIS_REASON = reason;
  note(`sem Redis: ${reason}`);
  note("os testes que exigem Redis vao PULAR (skip), nao falhar.");
}

function markAvailable(url: string, how: string) {
  process.env.REDIS_URL = url;
  process.env.HAIFLOW_TEST_REDIS = "1";
  delete process.env.HAIFLOW_TEST_REDIS_REASON;
  note(`Redis em ${url} (${how}).`);
}

async function waitReady(url: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await redisPing(url, 1_000)) return true;
    await Bun.sleep(200);
  }
  return false;
}

const NAME_PREFIX = "haiflow-test-redis-";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rede de seguranca para o unico caminho que o teardown normal nao cobre: matar
 * o runner a forca (SIGKILL / Stop-Process -Force) nao roda handler nenhum e
 * deixa o container de pe. O nome carrega o PID de quem o criou, entao aqui
 * removemos so os containers cujo dono ja morreu -- rodadas concorrentes ficam
 * intactas.
 */
function reapOrphans() {
  const list = run(["docker", "ps", "-a", "--filter", `name=${NAME_PREFIX}`, "--format", "{{.Names}}"]);
  if (!list.ok || !list.out) return;
  for (const name of list.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const pid = Number(name.slice(NAME_PREFIX.length).split("-")[0]);
    if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) continue;
    run(["docker", "rm", "-f", name]);
    note(`removi container orfao ${name} (dono morto).`);
  }
}

let containerName: string | null = null;

function destroyContainer() {
  if (!containerName) return;
  const name = containerName;
  containerName = null;
  run(["docker", "rm", "-f", name]);
}

async function provision(): Promise<void> {
  // O preload roda uma vez por processo de teste. Servidores filhos herdam o
  // env inteiro; se ja viermos decididos, nao decida de novo.
  if (process.env.HAIFLOW_TEST_REDIS) return;

  // Antes de qualquer decisao: varrer container que sobrou de runner morto.
  if (process.env.HAIFLOW_TEST_NO_DOCKER !== "1" && Bun.which("docker")) reapOrphans();

  // 1. Ambiente manda (CI). Usar e nao subir nada.
  const fromEnv = process.env.REDIS_URL;
  if (fromEnv) {
    process.env.HAIFLOW_TEST_REDIS = "1";
    if (await redisPing(fromEnv)) {
      note(`Redis em ${fromEnv} (REDIS_URL do ambiente).`);
    } else {
      // Nao mascarar: quem declarou REDIS_URL quer esse Redis. Se ele esta
      // morto, os testes devem ficar vermelhos, e nao verdes por skip.
      note(`ATENCAO: REDIS_URL=${fromEnv} veio do ambiente e nao respondeu PING.`);
      note("nenhum container sera subido (o ambiente manda); os testes vao falhar.");
    }
    return;
  }

  // 2. Redis local ja de pe.
  if (await redisPing(DEFAULT_LOCAL)) {
    markAvailable(DEFAULT_LOCAL, "ja estava de pe nesta maquina");
    return;
  }

  // 3. Container descartavel.
  if (process.env.HAIFLOW_TEST_NO_DOCKER === "1") {
    markUnavailable("HAIFLOW_TEST_NO_DOCKER=1 (docker desabilitado de proposito)");
    return;
  }
  if (!Bun.which("docker")) {
    markUnavailable("docker nao esta no PATH");
    return;
  }
  const daemon = run(["docker", "version", "--format", "{{.Server.Version}}"]);
  if (!daemon.ok) {
    markUnavailable(`daemon do docker nao respondeu (${daemon.err.split("\n")[0] || "sem detalhe"})`);
    return;
  }

  if (!run(["docker", "image", "inspect", IMAGE]).ok) {
    note(`baixando a imagem ${IMAGE} (primeira vez)...`);
    const pull = run(["docker", "pull", IMAGE]);
    if (!pull.ok) {
      markUnavailable(`falha ao baixar ${IMAGE} (${pull.err.split("\n")[0] || "sem detalhe"})`);
      return;
    }
  }

  const name = `haiflow-test-redis-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const start = run([
    "docker", "run", "-d", "--rm",
    "--name", name,
    // Porta efemera presa em loopback: nao colide com 6379 nem se expoe na rede.
    "-p", "127.0.0.1::6379",
    IMAGE,
    "redis-server", "--save", "", "--appendonly", "no",
  ]);
  if (!start.ok) {
    markUnavailable(`docker run falhou (${start.err.split("\n")[0] || "sem detalhe"})`);
    return;
  }
  containerName = name;

  const mapped = run(["docker", "port", name, "6379/tcp"]);
  const hostPort = mapped.out.split("\n")[0]?.trim().split(":").pop();
  if (!mapped.ok || !hostPort) {
    destroyContainer();
    markUnavailable(`nao consegui descobrir a porta publicada de ${name}`);
    return;
  }

  const url = `redis://127.0.0.1:${hostPort}`;
  if (!(await waitReady(url))) {
    destroyContainer();
    markUnavailable(`container ${name} subiu mas nao respondeu PING em ${READY_TIMEOUT_MS}ms`);
    return;
  }

  markAvailable(url, `container descartavel ${name}`);
}

await provision();

// Derrubar o container em todo caminho de saida: fim normal da suite, saida do
// processo e sinais. Todos convergem para destroyContainer(), que e idempotente.
process.on("exit", destroyContainer);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    destroyContainer();
    process.exit(130);
  });
}
try {
  const { afterAll } = await import("bun:test");
  afterAll(destroyContainer);
} catch {
  // Fora do runner de teste nao ha afterAll; os handlers de processo bastam.
}
