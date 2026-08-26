import { resolve, relative, isAbsolute, sep } from "path";
import { realpathSync, statSync } from "fs";

// --- Input sanitization ---

// CF-315: 64 nao cabia mais, e o estouro era SILENCIOSO.
//
// O SNAF nomeia a sessao como `<run_id>-<stage>`, e um uuid (36) mais o stage
// `architecture_contract_agent` (27) mais o hifen dao exatamente 64 -- o teto,
// batido na trave. `requirements_compiler-revision` ja passava, e virava
// `...-revis` na lista de sessoes; foi assim que apareceu na limpeza de
// 18/08/2026. Truncar nao e cosmetico: dois nomes que so diferem depois do
// corte viram A MESMA sessao, e duas tarefas passam a dividir uma sessao do
// Claude -- contexto de uma vazando na outra.
//
// A CF-315 acrescenta o modelo ao nome (para o `tmux ls` denunciar o que cada
// sessao consome), o que empurraria mais ainda. 96 da a folga que faltava sem
// chegar perto de limite nenhum de tmux ou de nome de diretorio.
export const MAX_SESSION_NAME = 96;

export function sanitizeSession(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, MAX_SESSION_NAME) || "default";
}

// CF-315: o modelo vira ARGUMENTO da linha de comando do `claude`, e chega de
// fora. Nao ha shell no meio (Bun.spawnSync recebe array), entao o risco nao e
// injecao de shell -- e injecao de FLAG: um "modelo" chamado
// `--dangerously-skip-permissions` seria passado ao claude como opcao, nao
// como valor. Por isso a regra proibe hifen inicial, e nao apenas caracteres
// estranhos.
//
// Devolve `null` quando nao ha escolha (ausente/vazio) e quando a escolha e
// invalida -- quem chama distingue os dois casos antes de chamar, porque
// "nao escolheu" e "escolheu errado" tem respostas diferentes.
const MODEL_OK = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function sanitizeModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const limpo = model.trim();
  if (!limpo || !MODEL_OK.test(limpo)) return null;
  return limpo;
}

// A sortable-ish, collision-resistant id: `<prefix>_<ms>_<6 base36 chars>`.
// Shared by task/map/event ids so the shape lives in one place.
export function prefixedId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateId(): string {
  return prefixedId("task");
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 128) || generateId();
}

export function tmuxName(session: string): string {
  return session;
}

// --- Prompt security ---

// Hard structural blocks: patterns that break out of the orchestrator itself.
// Everything else (injection, .env, cwd) is handled by the security preamble.
const STRUCTURAL_BLOCKS: [RegExp, string][] = [
  [/--dangerously-skip-permissions/i, "sandbox escape"],
  [/tmux\s+(send-keys|kill-session|new-session)/i, "tmux manipulation"],
];

export function validateStructural(prompt: string): { ok: boolean; reason?: string } {
  for (const [pattern, label] of STRUCTURAL_BLOCKS) {
    if (pattern.test(prompt)) {
      return { ok: false, reason: `Blocked: ${label}` };
    }
  }
  return { ok: true };
}


// --- Transcript path validation ---

// resolve() both, so each prefix is already in the platform's own shape before
// anything is compared. The literal "/tmp/claude" used to be compared raw, and
// on Windows resolve() turns a candidate into "C:\tmp\claude\..." -- which never
// starts with "/tmp/claude/". Every transcript was silently rejected there, and
// the Stop hook fell back to "(no text output)" instead of the real answer.
const TRANSCRIPT_PREFIXES = [
  resolve(process.env.HOME ?? "/", ".claude"),
  resolve("/tmp/claude"),
];

// Is `child` strictly inside `parent`? relative() does the containment test in
// the platform's own separator, so this works the same on POSIX and Windows
// (where it is also case-insensitive, as the filesystem is).
//
// The rejections the allowlist depends on all survive: the prefix directory
// itself relativises to "" (empty), an escape to ".." or "../…", a sibling like
// /tmp/claudeX to "../claudeX", and an unrelated root to an absolute path.
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export function isAllowedTranscriptPath(p: string): boolean {
  const resolved = resolve(p);
  let candidate = resolved;
  // If the path exists, resolve symlinks to the real target and require a
  // regular file. This defeats a symlink planted under the allowlist that
  // points outside it (e.g. /tmp/claude/x -> /etc/passwd, since /tmp is
  // world-writable). resolve() alone normalises `..` but does NOT follow links.
  try {
    const real = realpathSync(resolved);
    if (!statSync(real).isFile()) return false;
    candidate = real;
  } catch {
    // Non-existent / unstattable: fall back to the pure path policy below so a
    // not-yet-written transcript under an allowed prefix is still permitted.
  }
  return TRANSCRIPT_PREFIXES.some((prefix) => {
    if (isInside(prefix, candidate)) return true;
    // The prefix itself may be a symlink (e.g. macOS /tmp -> /private/tmp), so
    // also compare against its real path when it exists.
    try {
      return isInside(realpathSync(prefix), candidate);
    } catch {
      return false;
    }
  });
}

// --- Session boot recovery ---

// The subset of session state that boot recovery reasons about.
export interface RecoverableState {
  status: string;
  intervened?: boolean;
  waiting?: boolean;
}

export interface SessionRecoverPatch {
  status?: "idle";
  since?: string;
  intervened?: false;
  waiting?: false;
  waitingMessage?: undefined;
  waitingSince?: undefined;
}

// Compute the state patch to revive a running session at boot. A fresh process
// has no terminal websocket and no pending Notification, so a leftover
// `intervened` flag (which pauses queue draining) or `waiting` flag is stale and
// must be cleared; an "offline" session that is actually running comes back to
// "idle". Returns null when nothing needs changing.
export function recoverSessionPatch(state: RecoverableState, now: string): SessionRecoverPatch | null {
  const patch: SessionRecoverPatch = {};
  if (state.intervened) patch.intervened = false;
  if (state.waiting) {
    patch.waiting = false;
    patch.waitingMessage = undefined;
    patch.waitingSince = undefined;
  }
  if (state.status === "offline") {
    patch.status = "idle";
    patch.since = now;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// --- Rate limiting ---

export interface RateWindow {
  count: number;
  windowStart: number;
}

// Fixed-window rate limit. Mutates `state` for `key` and returns whether the
// request is allowed, plus seconds until the window resets when blocked. A
// limit <= 0 disables it (always allowed). Pure given `now`, so it's testable.
export function checkRateLimit(
  state: Map<string, RateWindow>,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  if (limit <= 0) return { allowed: true, retryAfterSec: 0 };
  const w = state.get(key);
  if (!w || now - w.windowStart >= windowMs) {
    state.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (w.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.windowStart + windowMs - now) / 1000)) };
  }
  w.count++;
  return { allowed: true, retryAfterSec: 0 };
}

// --- Template rendering ---

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}
