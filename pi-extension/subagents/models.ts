/**
 * Subagent model allowlist + model/thinking resolution.
 *
 * Deliberately dependency-free (node builtins only) so it can be unit-tested
 * standalone. The pi-ai thinking-level helpers are replicated in ~15 lines
 * (verified against pi-ai's `getSupportedThinkingLevels` / `clampThinkingLevel`)
 * instead of imported, because the repo's devDependencies pin the old
 * `@mariozechner/*` scope and must not grow a new runtime dependency.
 *
 * Allowlist entries use the same `provider/id` format as the `/model` picker
 * (e.g. `openrouter/z-ai/glm-5.3-flash`) — which is also the format `pi
 * --model` accepts, so entries can be passed through unchanged at spawn time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** All pi thinking levels, in ascending order (mirrors pi-ai's EXTENDED_THINKING_LEVELS). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_SUBAGENT_MODELS = [
  "openrouter/z-ai/glm-5.3-flash",
  "openrouter/deepseek/deepseek-v4-flash-0731",
];

/** The thinking level used when neither the spawn params nor the agent .md specify one. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** Minimal duck types so tests can pass fakes instead of a real ModelRegistry. */
export interface ModelLike {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface ModelRegistryLike {
  find(provider: string, modelId: string): ModelLike | undefined;
}

/** Resolve the global agent config dir, respecting PI_CODING_AGENT_DIR (mirrors index.ts). */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getModelAllowlistPath(): string {
  return join(getAgentConfigDir(), "subagent-models.json");
}

/** Parse a `provider/id` entry. Returns null for anything that isn't provider/id shaped. */
export function parseModelEntry(entry: string): { provider: string; id: string } | null {
  const slashIdx = entry.indexOf("/");
  if (slashIdx <= 0 || slashIdx === entry.length - 1) return null;
  return { provider: entry.slice(0, slashIdx), id: entry.slice(slashIdx + 1) };
}

export function writeModelAllowlist(models: string[]): void {
  const path = getModelAllowlistPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(models, null, 2) + "\n", "utf8");
}

/**
 * Read the allowlist, creating (or repairing) the file with the default models
 * when it's missing or unparseable.
 */
export function readModelAllowlist(): string[] {
  const path = getModelAllowlistPath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((m) => typeof m === "string" && parseModelEntry(m));
        if (valid.length > 0) return valid;
      }
    } catch {
      // fall through to reseed
    }
  }
  writeModelAllowlist([...DEFAULT_SUBAGENT_MODELS]);
  return [...DEFAULT_SUBAGENT_MODELS];
}

export type AddModelResult = { ok: true; models: string[] } | { ok: false; error: string };

/** Add a model to the allowlist (no-op if already present). */
export function addModelToAllowlist(entry: string): AddModelResult {
  if (!parseModelEntry(entry)) {
    return { ok: false, error: `"${entry}" is not a valid model entry. Use the provider/id format, e.g. openrouter/z-ai/glm-5.3-flash.` };
  }
  const models = readModelAllowlist();
  if (models.includes(entry)) return { ok: true, models };
  models.push(entry);
  writeModelAllowlist(models);
  return { ok: true, models };
}

export type RemoveModelResult = { ok: true; models: string[] } | { ok: false; error: string };

/**
 * Remove a model from the allowlist. Refuses to remove the last entry —
 * spawns default to the first entry, so an empty list would break launching.
 */
export function removeModelFromAllowlist(entry: string): RemoveModelResult {
  const models = readModelAllowlist();
  if (!models.includes(entry)) {
    return { ok: false, error: `"${entry}" is not in the subagent model allowlist. Current list: ${models.join(", ")}` };
  }
  if (models.length === 1) {
    return { ok: false, error: `Cannot remove "${entry}" — it is the only model in the allowlist. Add another model first.` };
  }
  const next = models.filter((m) => m !== entry);
  writeModelAllowlist(next);
  return { ok: true, models: next };
}

/**
 * Replica of pi-ai's `getSupportedThinkingLevels(model)`:
 *   - non-reasoning models support only "off";
 *   - a level mapped to `null` in thinkingLevelMap is unsupported;
 *   - "xhigh"/"max" require an explicit mapping to be considered supported.
 */
export function getSupportedThinkingLevels(model: ModelLike): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * Replica of pi-ai's `clampThinkingLevel(model, level)`: nearest supported
 * level, preferring same-or-higher, then lower, then the lowest supported.
 */
export function clampThinkingLevel(model: ModelLike, level: ThinkingLevel): ThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level);
  for (let i = requestedIndex + 1; i < THINKING_LEVELS.length; i++) {
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return supported[0] ?? "off";
}

export type ResolveSubagentModelOptions = {
  /** Model requested via the spawn params (provider/id). */
  requestedModel?: string | null;
  /** Thinking level requested via the spawn params. */
  requestedThinking?: string | null;
  /** Model from the agent .md frontmatter (fallback; normally undefined now). */
  agentModel?: string | null;
  /** Thinking level from the agent .md frontmatter (fallback; normally undefined now). */
  agentThinking?: string | null;
  /** Model registry used to validate thinking levels against the provider catalog. May be null (validation skipped). */
  registry?: ModelRegistryLike | null;
};

export type ResolveSubagentModelResult =
  | { ok: true; model: string; thinking: ThinkingLevel }
  | { ok: false; error: string };

/**
 * Resolve the model + thinking level for a subagent spawn:
 *   model    = requested ?? agent frontmatter ?? first allowlist entry
 *   thinking = requested ?? agent frontmatter ?? DEFAULT_THINKING_LEVEL
 * The requested model must be in the allowlist.
 *
 * Thinking-level validation against the provider catalog (when available):
 *   - an explicitly requested level that the model doesn't support is rejected;
 *   - a default/fallback level (agent frontmatter or DEFAULT_THINKING_LEVEL)
 *     is clamped to the nearest supported level instead, so spawns never fail
 *     merely because the default isn't in the model's supported set (e.g. the
 *     "medium" default against glm-5.3-flash, which only supports low/high/max).
 */
export function resolveSubagentModel(opts: ResolveSubagentModelOptions): ResolveSubagentModelResult {
  const allowlist = readModelAllowlist();

  const model = opts.requestedModel ?? opts.agentModel ?? allowlist[0];
  if (opts.requestedModel && !allowlist.includes(opts.requestedModel)) {
    return {
      ok: false,
      error:
        `Model "${opts.requestedModel}" is not in the subagent model allowlist. ` +
        `Allowed models: ${allowlist.join(", ")}. ` +
        `Add it first with /subagent-models add ${opts.requestedModel}.`,
    };
  }

  const requestedThinking = opts.requestedThinking ?? null;
  const thinking = requestedThinking ?? opts.agentThinking ?? DEFAULT_THINKING_LEVEL;
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    return {
      ok: false,
      error: `Unknown thinking level "${thinking}". Valid levels: ${THINKING_LEVELS.join(", ")}.`,
    };
  }

  const parsed = parseModelEntry(model);
  if (opts.registry && parsed) {
    const catalogModel = opts.registry.find(parsed.provider, parsed.id);
    if (catalogModel) {
      const supported = getSupportedThinkingLevels(catalogModel);
      if (!supported.includes(thinking as ThinkingLevel)) {
        if (requestedThinking) {
          return {
            ok: false,
            error:
              `Model "${model}" does not support thinking level "${requestedThinking}". ` +
              `Supported levels: ${supported.join(", ")}.`,
          };
        }
        // Default/fallback level: clamp instead of rejecting.
        return {
          ok: true,
          model,
          thinking: clampThinkingLevel(catalogModel, thinking as ThinkingLevel),
        };
      }
    }
    // Unknown to the catalog: pass through unchanged — pi clamps the thinking
    // level to the model's capabilities at child runtime.
  }

  return { ok: true, model, thinking: thinking as ThinkingLevel };
}
