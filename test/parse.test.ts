import { describe, expect, test } from "bun:test";
import {
	isEffectiveModelOverride,
	parseAgentFrontmatter,
	parseConfigLayer,
	parsePluginManifestName,
} from "../src/parse";

describe("parseAgentFrontmatter", () => {
	test("reads model from valid YAML frontmatter", () => {
		expect(parseAgentFrontmatter("---\nname: planner\nmodel: sonnet\n---\nBody\n")?.model).toBe("sonnet");
	});

	test("falls back to a flat key scan when the block is not valid YAML", () => {
		// A Claude Code multi-line description with an unquoted colon is common
		// and breaks a strict YAML parse; the file is still a real agent.
		const content = "---\nname: planner\ndescription: Plans work: strategically\nmodel: opus\n---\nBody\n";
		expect(parseAgentFrontmatter(content)?.model).toBe("opus");
	});

	test("returns undefined model when the field is absent", () => {
		expect(parseAgentFrontmatter("---\nname: x\ndescription: y\n---\nBody\n")?.model).toBeUndefined();
	});

	test("returns undefined for a file with no frontmatter block", () => {
		expect(parseAgentFrontmatter("Just a body, no frontmatter.")).toBeUndefined();
	});

	test("takes the first selector out of a CSV model list", () => {
		expect(parseAgentFrontmatter("---\nmodel: sonnet, haiku\n---\n")?.model).toBe("sonnet");
	});

	test("takes the first entry out of an array model list", () => {
		expect(parseAgentFrontmatter('---\nmodel:\n  - "@task"\n  - sonnet\n---\n')?.model).toBe("@task");
	});
});

describe("parsePluginManifestName", () => {
	test("reads name from a valid manifest", () => {
		expect(parsePluginManifestName('{"name":"agents-core","version":"1.0.0"}')).toBe("agents-core");
	});

	test("returns undefined for invalid JSON", () => {
		expect(parsePluginManifestName("not json")).toBeUndefined();
	});

	test("returns undefined when name is missing or blank", () => {
		expect(parsePluginManifestName("{}")).toBeUndefined();
		expect(parsePluginManifestName('{"name":"  "}')).toBeUndefined();
	});
});

describe("isEffectiveModelOverride", () => {
	test("undefined is not an override", () => {
		expect(isEffectiveModelOverride(undefined)).toBe(false);
	});

	test("a real selector is an override", () => {
		expect(isEffectiveModelOverride("zai/glm-5.3")).toBe(true);
	});

	test("an empty string or empty list is not an override", () => {
		expect(isEffectiveModelOverride("")).toBe(false);
		expect(isEffectiveModelOverride([])).toBe(false);
		expect(isEffectiveModelOverride([""])).toBe(false);
	});

	test("a CSV list with at least one real entry is an override", () => {
		expect(isEffectiveModelOverride(",zai/glm-5.3")).toBe(true);
	});
});

describe("parseConfigLayer", () => {
	test("absent config parses to the empty layer with no warnings", () => {
		const { layer, warnings } = parseConfigLayer(undefined, "test");
		expect(warnings).toEqual([]);
		expect(layer.tiers.size).toBe(0);
		expect(layer.agents.size).toBe(0);
		expect(layer.plugins.size).toBe(0);
	});

	test("parses tiers, agents, and nested plugin rules", () => {
		const { layer, warnings } = parseConfigLayer(
			{
				enabled: true,
				debug: false,
				tiers: { opus: "@slow", HAIKU: "@tiny" },
				agents: { guardian: false },
				plugins: { "agents-core": { sonnet: "@task:high" }, disabled: false },
			},
			"test",
		);
		expect(warnings).toEqual([]);
		expect(layer.enabled).toBe(true);
		expect(layer.tiers.get("opus")).toBe("@slow");
		// Tier keys are case-folded to match tiers.ts output.
		expect(layer.tiers.get("haiku")).toBe("@tiny");
		expect(layer.agents.get("guardian")).toBe(false);
		const pluginRule = layer.plugins.get("agents-core");
		expect(pluginRule).not.toBe(false);
		expect((pluginRule as ReadonlyMap<string, unknown>).get("sonnet")).toBe("@task:high");
		expect(layer.plugins.get("disabled")).toBe(false);
	});

	test("drops an invalid entry with a warning but keeps the rest of the layer", () => {
		const { layer, warnings } = parseConfigLayer({ tiers: { opus: "not-a-role" } }, "test");
		expect(layer.tiers.has("opus")).toBe(false);
		expect(warnings.some(w => w.includes("opus"))).toBe(true);
	});

	test("warns on an unknown top-level key without dropping known ones", () => {
		const { layer, warnings } = parseConfigLayer({ tiers: { opus: "@slow" }, typo: 1 }, "test");
		expect(layer.tiers.get("opus")).toBe("@slow");
		expect(warnings.some(w => w.includes("agentRoleRouter.typo"))).toBe(true);
	});

	test("rejects a non-mapping top level", () => {
		const { layer, warnings } = parseConfigLayer("nope", "test");
		expect(layer.tiers.size).toBe(0);
		expect(warnings.length).toBe(1);
	});
});
