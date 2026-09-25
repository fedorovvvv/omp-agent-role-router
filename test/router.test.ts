import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import type { RoleRule } from "../src/parse";
import { decide, inheritsParentModel, type SpawnFacts } from "../src/router";

const PARENT = "anthropic/claude-haiku-4-5";

function facts(overrides: Partial<SpawnFacts> = {}): SpawnFacts {
	return {
		agent: "guardian",
		modelRole: undefined,
		patterns: [PARENT],
		currentModel: PARENT,
		hasModelOverride: false,
		...overrides,
	};
}

const honoured = async () => ({ modelHonoured: true, declaredModel: undefined, plugin: undefined });
const declaring = (model: string, plugin?: string) => async () => ({
	modelHonoured: false,
	declaredModel: model,
	plugin,
});
const noDefinition = async () => undefined;

describe("inheritsParentModel", () => {
	test("a single pattern equal to the parent model inherits", () => {
		expect(inheritsParentModel([PARENT], PARENT)).toBe(true);
	});

	test("a single pattern with a thinking-level suffix on the parent model still inherits", () => {
		expect(inheritsParentModel([`${PARENT}:high`], PARENT)).toBe(true);
	});

	test("an explicit different model does not inherit", () => {
		expect(inheritsParentModel(["zai/glm-5.3"], PARENT)).toBe(false);
	});

	test("a retry-fallback chain of more than one pattern does not inherit", () => {
		expect(inheritsParentModel([PARENT, "zai/glm-5.3"], PARENT)).toBe(false);
	});

	test("no patterns does not inherit", () => {
		expect(inheritsParentModel([], PARENT)).toBe(false);
	});
});

describe("decide — passthrough cases", () => {
	test("agentRoleRouter.enabled: false disables routing entirely", async () => {
		const decision = await decide(facts(), { ...DEFAULT_CONFIG, enabled: false }, declaring("opus"));
		expect(decision).toEqual({ action: "skip", reason: "agentRoleRouter.enabled is false" });
	});

	test("an already-resolved role alias (event.modelRole set) is left alone", async () => {
		const decision = await decide(facts({ modelRole: "task" }), DEFAULT_CONFIG, declaring("opus"));
		expect(decision.action).toBe("skip");
	});

	test("a task.agentModelOverrides entry wins outright", async () => {
		const decision = await decide(facts({ hasModelOverride: true }), DEFAULT_CONFIG, declaring("opus"));
		expect(decision.action).toBe("skip");
	});

	test("an explicit per-call/pattern model (not the inherited parent) is left alone", async () => {
		const decision = await decide(facts({ patterns: ["zai/glm-5.3"] }), DEFAULT_CONFIG, declaring("opus"));
		expect(decision.action).toBe("skip");
	});

	test("no active parent model is left alone", async () => {
		const decision = await decide(facts({ currentModel: undefined }), DEFAULT_CONFIG, declaring("opus"));
		expect(decision.action).toBe("skip");
	});

	test("no agent definition resolves for the name: left alone", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, noDefinition);
		expect(decision).toEqual({ action: "skip", reason: "no agent definition file resolves for this name" });
	});

	test("omp already honours the definition's own model: left alone", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, honoured);
		expect(decision).toEqual({ action: "skip", reason: "omp honours this definition's own model" });
	});

	test("an unrecognised declared model with no matching tier: left alone", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, declaring("gpt-oss-120b"));
		expect(decision.action).toBe("skip");
	});

	test("a tier with no configured role: left alone", async () => {
		const config = { ...DEFAULT_CONFIG, tiers: new Map<string, RoleRule>() };
		const decision = await decide(facts(), config, declaring("opus"));
		expect(decision).toEqual({ action: "skip", reason: "no role configured for tier opus" });
	});

	test("model: inherit is left alone even if it happened to match a tier key", async () => {
		const config = { ...DEFAULT_CONFIG, tiers: new Map<string, RoleRule>([["inherit", "@task"]]) };
		const decision = await decide(facts(), config, declaring("inherit"));
		expect(decision).toEqual({ action: "skip", reason: "definition declares model: inherit" });
	});
});

describe("decide — routing", () => {
	test("zero-config: opus routes to @default", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, declaring("opus"));
		expect(decision).toEqual({ action: "route", role: "@default", note: "frontmatter opus → @default" });
	});

	test("zero-config: sonnet routes to @task", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, declaring("sonnet"));
		expect(decision).toEqual({ action: "route", role: "@task", note: "frontmatter sonnet → @task" });
	});

	test("zero-config: haiku routes to @smol", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, declaring("haiku"));
		expect(decision).toEqual({ action: "route", role: "@smol", note: "frontmatter haiku → @smol" });
	});

	test("a full Claude model id classifies through its family tier", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, declaring("claude-sonnet-4-5"));
		expect(decision).toEqual({ action: "route", role: "@task", note: "frontmatter claude-sonnet-4-5 (sonnet) → @task" });
	});

	test("a Codex-vocabulary model routes through the gpt-* tiers", async () => {
		const decision = await decide(facts(), DEFAULT_CONFIG, declaring("gpt-5.6-luna"));
		expect(decision).toEqual({
			action: "route",
			role: "@smol",
			note: "frontmatter gpt-5.6-luna (gpt-mini) → @smol",
		});
	});

	test("agentRoleRouter.agents.<name> overrides the tier for that agent", async () => {
		const config = { ...DEFAULT_CONFIG, agents: new Map<string, RoleRule>([["guardian", "@slow"]]) };
		const decision = await decide(facts(), config, declaring("opus"));
		expect(decision).toEqual({ action: "route", role: "@slow", note: "agentRoleRouter.agents.guardian → @slow" });
	});

	test("agentRoleRouter.agents.<name>: false pins the agent untouched regardless of its tier", async () => {
		const config = { ...DEFAULT_CONFIG, agents: new Map<string, RoleRule>([["guardian", false]]) };
		const decision = await decide(facts(), config, declaring("opus"));
		expect(decision).toEqual({ action: "skip", reason: "agentRoleRouter.agents.guardian is false" });
	});

	test("a per-plugin tier rule wins over the global tier map", async () => {
		const config = {
			...DEFAULT_CONFIG,
			plugins: new Map([["agents-core", new Map<string, RoleRule>([["opus", "@slow"]])]]),
		};
		const decision = await decide(facts(), config, declaring("opus", "agents-core"));
		expect(decision).toEqual({
			action: "route",
			role: "@slow",
			note: "frontmatter opus → @slow [plugins.agents-core]",
		});
	});

	test("agentRoleRouter.plugins.<name>: false pins every agent of that plugin untouched", async () => {
		const config = { ...DEFAULT_CONFIG, plugins: new Map<string, false>([["agents-core", false]]) };
		const decision = await decide(facts(), config, declaring("opus", "agents-core"));
		expect(decision).toEqual({ action: "skip", reason: "agentRoleRouter.plugins.agents-core is false" });
	});
});
