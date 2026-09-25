import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_TIERS, loadConfig, mergeLayers } from "../src/config";
import { parseConfigLayer } from "../src/parse";

describe("DEFAULT_TIERS", () => {
	test("zero-config map: opus -> @default, sonnet -> @task, haiku -> @smol", () => {
		expect(DEFAULT_TIERS.get("opus")).toBe("@default");
		expect(DEFAULT_TIERS.get("sonnet")).toBe("@task");
		expect(DEFAULT_TIERS.get("haiku")).toBe("@smol");
	});

	test("has a Codex tier map too", () => {
		expect(DEFAULT_TIERS.get("gpt-flagship")).toBe("@default");
		expect(DEFAULT_TIERS.get("gpt-mid")).toBe("@task");
		expect(DEFAULT_TIERS.get("gpt-mini")).toBe("@smol");
	});
});

describe("loadConfig", () => {
	test("absent user and project blocks resolve to the defaults", () => {
		const { config, warnings } = loadConfig(undefined, undefined);
		expect(warnings).toEqual([]);
		expect(config.enabled).toBe(true);
		expect(config.tiers.get("opus")).toBe("@default");
	});

	test("a user override replaces one tier and keeps the rest of the defaults", () => {
		const { config } = loadConfig({ tiers: { opus: "@slow" } }, undefined);
		expect(config.tiers.get("opus")).toBe("@slow");
		expect(config.tiers.get("sonnet")).toBe("@task");
	});

	test("project config overrides the user layer for the same key", () => {
		const { config } = loadConfig({ tiers: { opus: "@slow" } }, { tiers: { opus: "@tiny" } });
		expect(config.tiers.get("opus")).toBe("@tiny");
	});

	test("project plugin rules merge onto user plugin rules for the same plugin instead of replacing them", () => {
		const { config } = mergeAndUnwrap(
			{ plugins: { "agents-core": { opus: "@slow" } } },
			{ plugins: { "agents-core": { sonnet: "@task:high" } } },
		);
		const rule = config.plugins.get("agents-core");
		expect(rule).not.toBe(false);
		const map = rule as ReadonlyMap<string, unknown>;
		expect(map.get("opus")).toBe("@slow");
		expect(map.get("sonnet")).toBe("@task:high");
	});

	test("project setting a plugin to false replaces the user's per-tier rules for it", () => {
		const { config } = mergeAndUnwrap(
			{ plugins: { "agents-core": { opus: "@slow" } } },
			{ plugins: { "agents-core": false } },
		);
		expect(config.plugins.get("agents-core")).toBe(false);
	});

	function mergeAndUnwrap(user: unknown, project: unknown) {
		return {
			config: mergeLayers([parseConfigLayer(user, "user").layer, parseConfigLayer(project, "project").layer]),
		};
	}
});

describe("mergeLayers", () => {
	test("no layers returns the default config unchanged", () => {
		expect(mergeLayers([])).toEqual(DEFAULT_CONFIG);
	});
});
