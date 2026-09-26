import { describe, expect, mock, test } from "bun:test";
import * as path from "node:path";
import type {
	BeforeSubagentSpawnEvent,
	BeforeSubagentSpawnEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import agentRoleRouter from "../src/index";

/**
 * Exercises the registered `before_subagent_spawn` handler end to end against
 * a minimal stand-in for `ExtensionAPI`/`ExtensionContext`, built from real
 * fixture files, without a live omp process. Proves the wiring — settings
 * reads, the discovery call, the decision, role resolution, the returned
 * `{ model, note }` shape — not omp's own internals (those are covered by the
 * real `omp -e` probes in the README's verification table).
 *
 * The stand-ins are cast through `unknown` at the boundary: they implement
 * only the handful of members `src/index.ts` actually calls, not the full
 * multi-hundred-member SDK interfaces.
 */

const FIXTURES = path.join(import.meta.dir, "fixtures");
const CLAUDE_PLUGIN = path.join(FIXTURES, "claude-plugin", "agents");

interface FakeModel {
	provider: string;
	id: string;
}

interface StubApi {
	readonly pi: ExtensionAPI;
	readonly fire: (event: BeforeSubagentSpawnEvent) => Promise<BeforeSubagentSpawnEventResult | void>;
	readonly notifications: readonly string[];
}

function buildStub(options: {
	globalSettings?: Record<string, unknown>;
	projectSettings?: Record<string, unknown>;
	overrides?: Record<string, string>;
	current: FakeModel;
	roles: Record<string, FakeModel>;
}): StubApi {
	let handler: ((event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => unknown) | undefined;
	const notifications: string[] = [];

	const settingsInstance = {
		getGlobalSettings: () => options.globalSettings ?? {},
		getProjectSettings: () => options.projectSettings ?? {},
		get: (key: string) => (key === "task.agentModelOverrides" ? (options.overrides ?? {}) : undefined),
	};

	// omp 18.3: the extension reads the session-scoped settings (`findScopedSettings`) and resolves
	// `task.agentModelOverrides` through the settings registry (`lookup`) instead of the removed
	// `Settings.instance` / `Settings#get`. Both SDK subpaths are replaced for this test.
	mock.module("@oh-my-pi/pi-coding-agent/config/settings", () => ({ findScopedSettings: () => settingsInstance }));
	mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
		lookup: (key: string) => ({ get: () => settingsInstance.get(key) }),
	}));
	const sdk = {
		discoverAgents: async () => ({
			agents: [{ name: "planner", filePath: path.join(CLAUDE_PLUGIN, "planner.md") }],
		}),
		getAgentDir: () => "/fake/.omp/agent",
	};

	const stubApi = {
		logger: { warn: () => undefined, debug: () => undefined },
		pi: sdk,
		on: (_event: string, registered: (event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => unknown) => {
			handler = registered;
		},
	};

	const stubContext = {
		cwd: "/fake/project",
		hasUI: false,
		ui: { notify: (message: string) => notifications.push(message) },
		models: {
			current: () => options.current,
			resolve: (spec: string) => options.roles[spec],
		},
	};

	const pi = stubApi as unknown as ExtensionAPI;
	const ctx = stubContext as unknown as ExtensionContext;
	return {
		pi,
		notifications,
		fire: async event => handler?.(event, ctx) as Promise<BeforeSubagentSpawnEventResult | void>,
	};
}

function spawnEvent(patterns: readonly string[]): BeforeSubagentSpawnEvent {
	return { type: "before_subagent_spawn", agent: "planner", invocationKind: "task", patterns: [...patterns] };
}

describe("agentRoleRouter extension wiring", () => {
	test("routes a Claude-dialect sonnet plugin agent that inherited the parent model to @task", async () => {
		const parent = { provider: "anthropic", id: "claude-haiku-4-5" };
		const taskModel = { provider: "anthropic", id: "claude-sonnet-5" };
		const stub = buildStub({ current: parent, roles: { "@task": taskModel } });
		agentRoleRouter(stub.pi);

		const result = await stub.fire(spawnEvent(["anthropic/claude-haiku-4-5"]));

		expect(result).toEqual({ model: "@task", note: "frontmatter sonnet → @task" });
	});

	test("leaves the spawn untouched when task.agentModelOverrides already has an entry", async () => {
		const parent = { provider: "anthropic", id: "claude-haiku-4-5" };
		const stub = buildStub({ current: parent, roles: {}, overrides: { planner: "zai/glm-5.3" } });
		agentRoleRouter(stub.pi);

		const result = await stub.fire(spawnEvent(["anthropic/claude-haiku-4-5"]));

		expect(result).toBeUndefined();
	});

	test("a user agentRoleRouter.agents override reaches the decision", async () => {
		const parent = { provider: "anthropic", id: "claude-haiku-4-5" };
		const slow = { provider: "anthropic", id: "claude-opus-5-5" };
		const stub = buildStub({
			current: parent,
			roles: { "@slow": slow },
			globalSettings: { agentRoleRouter: { agents: { planner: "@slow" } } },
		});
		agentRoleRouter(stub.pi);

		const result = await stub.fire(spawnEvent(["anthropic/claude-haiku-4-5"]));

		expect(result).toEqual({ model: "@slow", note: "agentRoleRouter.agents.planner → @slow" });
	});

	// omp 18.3 resolves a returned role again against the CHILD session's settings; the parent's
	// ExtensionContext.models is only a snapshot and may not know a role defined solely in an
	// isolated child overlay. So the role is returned even when the parent cannot resolve it.
	test("returns the role even when the parent's model facade cannot resolve it", async () => {
		const parent = { provider: "anthropic", id: "claude-haiku-4-5" };
		const stub = buildStub({ current: parent, roles: {} });
		agentRoleRouter(stub.pi);

		const result = await stub.fire(spawnEvent(["anthropic/claude-haiku-4-5"]));

		expect(result?.model).toBe("@task");
	});

	test("falls back to the single inherited pattern when the headless context has no current model", async () => {
		const stub = buildStub({ current: undefined as unknown as FakeModel, roles: {} });
		agentRoleRouter(stub.pi);

		expect((await stub.fire(spawnEvent(["anthropic/claude-haiku-4-5"])))?.model).toBe("@task");
		expect(await stub.fire(spawnEvent(["anthropic/claude-haiku-4-5", "zai/glm-5.3"]))).toBeUndefined();
	});

	test("an explicit non-inherited pattern is left untouched (never overrides an explicit per-call model)", async () => {
		const parent = { provider: "anthropic", id: "claude-haiku-4-5" };
		const stub = buildStub({ current: parent, roles: { "@task": { provider: "zai", id: "glm-5.3" } } });
		agentRoleRouter(stub.pi);

		const result = await stub.fire(spawnEvent(["zai/glm-5.3"]));

		expect(result).toBeUndefined();
	});
});
