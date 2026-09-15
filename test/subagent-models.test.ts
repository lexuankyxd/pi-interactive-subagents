/**
 * Unit tests for the subagent model allowlist + model/thinking resolution
 * (pi-extension/subagents/models.ts). Pure unit tests — no tmux, no pi runtime.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_SUBAGENT_MODELS,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  addModelToAllowlist,
  getSupportedThinkingLevels,
  getModelAllowlistPath,
  parseModelEntry,
  readModelAllowlist,
  removeModelFromAllowlist,
  resolveSubagentModel,
  type ModelLike,
  type ModelRegistryLike,
} from "../pi-extension/subagents/models.ts";

// --- Helpers ---

let testDir: string;
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

function withTempAgentDir() {
  testDir = mkdtempSync(join(tmpdir(), "subagent-models-test-"));
  process.env.PI_CODING_AGENT_DIR = testDir;
}

// Duck-typed fake registry models for the thinking-level validation tests.
const reasoningModel: ModelLike = { reasoning: true };
const nonReasoningModel: ModelLike = { reasoning: false };
const mappedModel: ModelLike = {
  reasoning: true,
  thinkingLevelMap: { off: null, low: "enable", medium: "enable", high: "enable" },
};

function fakeRegistry(models: Record<string, ModelLike>): ModelRegistryLike {
  return {
    find(provider, id) {
      return models[`${provider}/${id}`];
    },
  };
}

beforeEach(() => withTempAgentDir());
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
});

// --- Allowlist persistence ---

describe("subagent model allowlist", () => {
  it("seeds the file with the default models on first read", () => {
    assert.equal(existsSync(getModelAllowlistPath()), false);
    const models = readModelAllowlist();
    assert.deepEqual(models, DEFAULT_SUBAGENT_MODELS);
    assert.equal(models[0], "openrouter/z-ai/glm-5.3-flash");
    assert.deepEqual(JSON.parse(readFileSync(getModelAllowlistPath(), "utf8")), DEFAULT_SUBAGENT_MODELS);
  });

  it("repairs an unparseable allowlist file by reseeding", () => {
    writeFileSync(getModelAllowlistPath(), "{not json", "utf8");
    const models = readModelAllowlist();
    assert.deepEqual(models, DEFAULT_SUBAGENT_MODELS);
  });

  it("repairs a allowlist file with no valid provider/id entries", () => {
    writeFileSync(getModelAllowlistPath(), JSON.stringify(["not-a-model-entry"]), "utf8");
    assert.deepEqual(readModelAllowlist(), DEFAULT_SUBAGENT_MODELS);
  });

  it("respects an existing custom allowlist", () => {
    writeFileSync(getModelAllowlistPath(), JSON.stringify(["openrouter/foo/bar"]), "utf8");
    assert.deepEqual(readModelAllowlist(), ["openrouter/foo/bar"]);
  });

  it("adds a model and persists it", () => {
    const result = addModelToAllowlist("openrouter/x/y");
    assert.ok(result.ok);
    assert.deepEqual(result.models, [...DEFAULT_SUBAGENT_MODELS, "openrouter/x/y"]);
    assert.deepEqual(readModelAllowlist(), [...DEFAULT_SUBAGENT_MODELS, "openrouter/x/y"]);
  });

  it("treats a duplicate add as a no-op", () => {
    addModelToAllowlist("openrouter/x/y");
    const result = addModelToAllowlist("openrouter/x/y");
    assert.ok(result.ok);
    assert.deepEqual(result.models, [...DEFAULT_SUBAGENT_MODELS, "openrouter/x/y"]);
  });

  it("rejects entries without the provider/id shape", () => {
    const result = addModelToAllowlist("just-a-name");
    assert.ok(!result.ok);
    assert.match(result.error, /provider\/id/);
    assert.deepEqual(readModelAllowlist(), DEFAULT_SUBAGENT_MODELS);
  });

  it("removes a model and persists the change", () => {
    addModelToAllowlist("openrouter/x/y");
    const result = removeModelFromAllowlist(DEFAULT_SUBAGENT_MODELS[0]);
    assert.ok(result.ok);
    assert.deepEqual(result.models, [DEFAULT_SUBAGENT_MODELS[1], "openrouter/x/y"]);
    assert.deepEqual(readModelAllowlist(), [DEFAULT_SUBAGENT_MODELS[1], "openrouter/x/y"]);
  });

  it("refuses to remove a model that is not listed", () => {
    const result = removeModelFromAllowlist("openrouter/nope/nope");
    assert.ok(!result.ok);
    assert.match(result.error, /not in the subagent model allowlist/);
  });

  it("refuses to remove the last remaining entry", () => {
    writeFileSync(getModelAllowlistPath(), JSON.stringify(["openrouter/last/one"]), "utf8");
    const result = removeModelFromAllowlist("openrouter/last/one");
    assert.ok(!result.ok);
    assert.match(result.error, /only model/);
    assert.deepEqual(readModelAllowlist(), ["openrouter/last/one"]);
  });
});

// --- parseModelEntry ---

describe("parseModelEntry", () => {
  it("parses provider/id", () => {
    assert.deepEqual(parseModelEntry("openrouter/z-ai/glm-5.3-flash"), {
      provider: "openrouter",
      id: "z-ai/glm-5.3-flash",
    });
  });

  it("rejects entries without a slash", () => {
    assert.equal(parseModelEntry("glm-5.3-flash"), null);
  });

  it("rejects empty halves", () => {
    assert.equal(parseModelEntry("/id"), null);
    assert.equal(parseModelEntry("provider/"), null);
  });
});

// --- getSupportedThinkingLevels (replica of pi-ai semantics) ---

describe("getSupportedThinkingLevels", () => {
  it("returns only off for non-reasoning models", () => {
    assert.deepEqual(getSupportedThinkingLevels(nonReasoningModel), ["off"]);
  });

  it("returns off..high for reasoning models without a map (xhigh/max need explicit mappings)", () => {
    assert.deepEqual(getSupportedThinkingLevels(reasoningModel), ["off", "minimal", "low", "medium", "high"]);
  });

  it("excludes levels mapped to null", () => {
    const supported = getSupportedThinkingLevels(mappedModel);
    assert.ok(!supported.includes("off"), "off is mapped to null and must be excluded");
    for (const level of ["minimal", "low", "medium", "high"] as const) {
      if (level === "minimal") continue; // minimal is unmapped → supported by default
      assert.ok(supported.includes(level));
    }
    assert.ok(!supported.includes("xhigh"), "xhigh requires an explicit mapping");
    assert.ok(!supported.includes("max"), "max requires an explicit mapping");
  });
});

// --- resolveSubagentModel ---

describe("resolveSubagentModel", () => {
  it("defaults to the first allowlist entry and the default thinking level", () => {
    const result = resolveSubagentModel({});
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.model, DEFAULT_SUBAGENT_MODELS[0]);
      assert.equal(result.thinking, DEFAULT_THINKING_LEVEL);
    }
  });

  it("honors a requested model that is in the allowlist", () => {
    const result = resolveSubagentModel({ requestedModel: DEFAULT_SUBAGENT_MODELS[1] });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.model, DEFAULT_SUBAGENT_MODELS[1]);
      assert.equal(result.thinking, DEFAULT_THINKING_LEVEL);
    }
  });

  it("honors a requested thinking level", () => {
    const result = resolveSubagentModel({ requestedThinking: "low" });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "low");
  });

  it("rejects a requested model that is not in the allowlist, listing the allowed models", () => {
    const result = resolveSubagentModel({ requestedModel: "openrouter/anthropic/claude-sonnet-4.5" });
    assert.ok(!result.ok);
    assert.match(result.error, /not in the subagent model allowlist/);
    assert.match(result.error, new RegExp(DEFAULT_SUBAGENT_MODELS[0].replace(/[/.]/g, "\\$&")));
    assert.match(result.error, /\/subagent-models add/);
  });

  it("falls back to the agent frontmatter model before the allowlist default", () => {
    const result = resolveSubagentModel({ agentModel: DEFAULT_SUBAGENT_MODELS[1] });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.model, DEFAULT_SUBAGENT_MODELS[1]);
  });

  it("lets a requested model override the agent frontmatter model", () => {
    const result = resolveSubagentModel({
      requestedModel: DEFAULT_SUBAGENT_MODELS[0],
      agentModel: DEFAULT_SUBAGENT_MODELS[1],
    });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.model, DEFAULT_SUBAGENT_MODELS[0]);
  });

  it("falls back to the agent frontmatter thinking level before the default", () => {
    const result = resolveSubagentModel({ agentThinking: "high" });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "high");
  });

  it("rejects an unknown thinking level", () => {
    const result = resolveSubagentModel({ requestedThinking: "ultrathink" });
    assert.ok(!result.ok);
    assert.match(result.error, /Unknown thinking level/);
  });

  it("rejects an explicitly requested thinking level the catalog model does not support, listing supported levels", () => {
    const registry = fakeRegistry({ [DEFAULT_SUBAGENT_MODELS[0]]: mappedModel });
    const result = resolveSubagentModel({
      requestedModel: DEFAULT_SUBAGENT_MODELS[0],
      requestedThinking: "off", // mapped to null → unsupported
      registry,
    });
    assert.ok(!result.ok);
    assert.match(result.error, /does not support thinking level "off"/);
    assert.match(result.error, /Supported levels:/);
  });

  it("clamps a default thinking level to the nearest supported level instead of rejecting", () => {
    // mappedModel supports low/medium/high — "medium" default is fine, but a
    // fallback of "xhigh" (unmapped) clamps down to "high".
    const registry = fakeRegistry({ [DEFAULT_SUBAGENT_MODELS[0]]: mappedModel });
    const result = resolveSubagentModel({
      requestedModel: DEFAULT_SUBAGENT_MODELS[0],
      agentThinking: "xhigh",
      registry,
    });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "high");
  });

  it("clamps the default level upward when nothing at-or-below is supported", () => {
    // Only "high" is mapped; off/minimal/low/medium are all null → unsupported.
    const registry = fakeRegistry({
      [DEFAULT_SUBAGENT_MODELS[0]]: {
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
      },
    });
    const result = resolveSubagentModel({ requestedModel: DEFAULT_SUBAGENT_MODELS[0], registry });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "high");
  });

  it("real catalog: glm-5.3-flash default clamps medium → high (supports low/high/max only)", () => {
    const registry = fakeRegistry({
      "openrouter/z-ai/glm-5.3-flash": {
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      },
    });
    const result = resolveSubagentModel({ requestedModel: "openrouter/z-ai/glm-5.3-flash", registry });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "high");
  });

  it("real catalog: deepseek-v4-flash-0731 default clamps medium → high (supports off/high/xhigh only)", () => {
    const registry = fakeRegistry({
      "openrouter/deepseek/deepseek-v4-flash-0731": {
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null },
      },
    });
    const result = resolveSubagentModel({ requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731", registry });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "high");
  });

  it("real catalog: explicitly requesting low on deepseek-v4-flash-0731 is rejected", () => {
    const registry = fakeRegistry({
      "openrouter/deepseek/deepseek-v4-flash-0731": {
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null },
      },
    });
    const result = resolveSubagentModel({
      requestedModel: "openrouter/deepseek/deepseek-v4-flash-0731",
      requestedThinking: "low",
      registry,
    });
    assert.ok(!result.ok);
    assert.match(result.error, /Supported levels: off, high, xhigh/);
  });

  it("rejects a thinking level above off for a non-reasoning catalog model", () => {
    const registry = fakeRegistry({ [DEFAULT_SUBAGENT_MODELS[0]]: nonReasoningModel });
    const result = resolveSubagentModel({
      requestedModel: DEFAULT_SUBAGENT_MODELS[0],
      requestedThinking: "medium",
      registry,
    });
    assert.ok(!result.ok);
    assert.match(result.error, /Supported levels: off/);
  });

  it("accepts a thinking level the catalog model supports", () => {
    const registry = fakeRegistry({ [DEFAULT_SUBAGENT_MODELS[0]]: mappedModel });
    const result = resolveSubagentModel({
      requestedModel: DEFAULT_SUBAGENT_MODELS[0],
      requestedThinking: "high",
      registry,
    });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "high");
  });

  it("passes through unchanged when the model is unknown to the catalog (pi clamps at runtime)", () => {
    const registry = fakeRegistry({});
    const result = resolveSubagentModel({
      requestedModel: DEFAULT_SUBAGENT_MODELS[0],
      requestedThinking: "xhigh",
      registry,
    });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.thinking, "xhigh");
  });

  it("skips catalog validation when no registry is available", () => {
    const result = resolveSubagentModel({ requestedThinking: "xhigh", registry: null });
    assert.ok(result.ok);
  });
});
