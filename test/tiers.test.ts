import { describe, expect, test } from "bun:test";
import { classifyDeclaredModel, normalizeModelId } from "../src/tiers";

describe("normalizeModelId", () => {
	test("strips provider prefix, thinking suffix, context tag, and snapshot", () => {
		expect(normalizeModelId("anthropic/claude-opus-4-5:high")).toBe("claude-opus-4-5");
		expect(normalizeModelId("opus[1m]")).toBe("opus");
		expect(normalizeModelId("claude-opus-4-1@20250805")).toBe("claude-opus-4-1");
		expect(normalizeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"us.anthropic.claude-sonnet-4-5-20250929-v1",
		);
	});
});

describe("classifyDeclaredModel — Claude Code vocabulary", () => {
	test.each([
		["opus", "opus"],
		["sonnet", "sonnet"],
		["haiku", "haiku"],
		["best", "opus"],
		["opus[1m]", "opus"],
		["claude-sonnet-4-5", "sonnet"],
		["claude-3-5-haiku-20241022", "haiku"],
		["anthropic/claude-opus-4-5", "opus"],
		["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "sonnet"],
		["claude-opus-4-1@20250805", "opus"],
		["claude-fable-5", "fable"],
	])("%s -> claude/%s", (declared, tier) => {
		expect(classifyDeclaredModel(declared)).toEqual({ family: "claude", tier });
	});
});

describe("classifyDeclaredModel — OpenAI/Codex vocabulary", () => {
	test.each([
		["gpt-5.6-luna", "gpt-mini"],
		["gpt-6-luna", "gpt-mini"],
		["gpt-5.4-mini", "gpt-mini"],
		["gpt-5.1-codex-mini", "gpt-mini"],
		["gpt-5.4-nano", "gpt-mini"],
		["gpt-5.6-sol", "gpt-flagship"],
		["gpt-6-astra", "gpt-flagship"],
		["gpt-5.1-codex-max", "gpt-flagship"],
		["gpt-5.5", "gpt-flagship"],
		["o3", "gpt-flagship"],
		["gpt-5.6-terra", "gpt-mid"],
		["gpt-5.3-codex", "gpt-mid"],
		["gpt-5-codex", "gpt-mid"],
		["codex-mini-latest", "gpt-mini"],
	])("%s -> openai/%s", (declared, tier) => {
		expect(classifyDeclaredModel(declared)).toEqual({ family: "openai", tier });
	});

	test("provider-qualified id classifies the same as bare", () => {
		expect(classifyDeclaredModel("openai-codex/gpt-5.6-terra")).toEqual({ family: "openai", tier: "gpt-mid" });
	});
});

describe("classifyDeclaredModel — unrecognised input", () => {
	test.each(["gpt-oss-120b", "gpt-4o-audio-preview", "grok-4", "deepseek-v4", "", "   "])(
		"%s classifies as undefined",
		declared => {
			expect(classifyDeclaredModel(declared)).toBeUndefined();
		},
	);
});
