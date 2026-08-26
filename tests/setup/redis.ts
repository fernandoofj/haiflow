/**
 * Portao de Redis para os testes.
 *
 * Le o que o preload (tests/setup/redis-testcontainer.ts) decidiu. Quando ha
 * Redis, `describeRedis`/`testRedis` sao o `describe`/`test` normais e as
 * asserçoes valem de verdade. Quando nao ha (sem docker, sem Redis local),
 * viram skip -- com o motivo impresso uma unica vez, para que um verde por
 * skip nunca seja confundido com um verde por prova.
 */
import { describe, test } from "bun:test";

export const redisAvailable = process.env.HAIFLOW_TEST_REDIS === "1";
export const redisSkipReason =
  process.env.HAIFLOW_TEST_REDIS_REASON ?? "Redis indisponivel nesta maquina";

let announced = false;
function announce() {
  if (announced || redisAvailable) return;
  announced = true;
  console.error(`[haiflow-test/redis] SKIP dos testes que exigem Redis: ${redisSkipReason}`);
}

export const describeRedis: typeof describe = redisAvailable
  ? describe
  : ((...args: Parameters<typeof describe>) => {
      announce();
      return describe.skip(...args);
    }) as typeof describe;

export const testRedis: typeof test = redisAvailable
  ? test
  : ((...args: Parameters<typeof test>) => {
      announce();
      return test.skip(...args);
    }) as typeof test;
