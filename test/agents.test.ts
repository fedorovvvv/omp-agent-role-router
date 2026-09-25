import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentDefinitionIndex, type DiscoveredAgent } from "../src/agents";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const CLAUDE_PLUGIN = path.join(FIXTURES, "claude-plugin", "agents");
const NATIVE = path.join(FIXTURES, "native-omp");

function stubDiscovery(agents: readonly DiscoveredAgent[]) {
	let calls = 0;
	const discover = async () => {
		calls++;
		return { agents };
	};
	return { discover, calls: () => calls };
}

describe("AgentDefinitionIndex.lookup", () => {
	test("returns undefined for a name no definition resolves", async () => {
		const { discover } = stubDiscovery([]);
		const index = new AgentDefinitionIndex(discover, () => []);
		expect(await index.lookup("/tmp", "ghost")).toBeUndefined();
	});

	test("modelHonoured: true when omp kept the definition's own model (native .omp agent)", async () => {
		const { discover } = stubDiscovery([
			{ name: "reviewer", filePath: path.join(NATIVE, "reviewer.md"), model: ["@review"] },
		]);
		const index = new AgentDefinitionIndex(discover, () => []);
		expect(await index.lookup("/tmp", "reviewer")).toEqual({
			modelHonoured: true,
			declaredModel: undefined,
			plugin: undefined,
		});
	});

	test("reads the declared model and plugin name for a Claude-dialect plugin agent (model dropped by omp)", async () => {
		const { discover } = stubDiscovery([{ name: "planner", filePath: path.join(CLAUDE_PLUGIN, "planner.md") }]);
		const index = new AgentDefinitionIndex(discover, () => []);
		expect(await index.lookup("/tmp", "planner")).toEqual({
			modelHonoured: false,
			declaredModel: "sonnet",
			plugin: "agents-core",
		});
	});

	test("a multi-line description with an unquoted colon does not hide the model field", async () => {
		// planner.md's description is exactly this case; re-asserted directly against the parsed value.
		const { discover } = stubDiscovery([{ name: "planner", filePath: path.join(CLAUDE_PLUGIN, "planner.md") }]);
		const index = new AgentDefinitionIndex(discover, () => []);
		const facts = await index.lookup("/tmp", "planner");
		expect(facts?.declaredModel).toBe("sonnet");
	});

	test("a definition with no model field declares undefined", async () => {
		const { discover } = stubDiscovery([{ name: "no-model", filePath: path.join(CLAUDE_PLUGIN, "no-model.md") }]);
		const index = new AgentDefinitionIndex(discover, () => []);
		expect((await index.lookup("/tmp", "no-model"))?.declaredModel).toBeUndefined();
	});

	test("first-wins: when two entries share a name, the earlier one in discovery order is used", async () => {
		const { discover } = stubDiscovery([
			{ name: "guardian", filePath: path.join(CLAUDE_PLUGIN, "guardian.md") }, // opus, wins
			{ name: "guardian", filePath: path.join(CLAUDE_PLUGIN, "tester.md") }, // sonnet, shadowed
		]);
		const index = new AgentDefinitionIndex(discover, () => []);
		expect((await index.lookup("/tmp", "guardian"))?.declaredModel).toBe("opus");
	});
});

describe("AgentDefinitionIndex caching", () => {
	const scratchDir = path.join(FIXTURES, ".scratch-cache");
	const watchedFile = path.join(scratchDir, "config.yml");
	const agentFile = path.join(scratchDir, "agent.md");

	beforeEach(async () => {
		await fs.mkdir(scratchDir, { recursive: true });
		await fs.writeFile(watchedFile, "marker: 1\n");
		await fs.writeFile(agentFile, "---\nname: probe\nmodel: sonnet\n---\nBody\n");
	});

	afterEach(async () => {
		await fs.rm(scratchDir, { recursive: true, force: true });
	});

	test("repeated lookups for an unchanged tree run discovery and file parsing exactly once", async () => {
		const { discover, calls } = stubDiscovery([{ name: "probe", filePath: agentFile }]);
		const index = new AgentDefinitionIndex(discover, () => [watchedFile]);
		await index.lookup("/tmp", "probe");
		await index.lookup("/tmp", "probe");
		await index.lookup("/tmp", "probe");
		expect(calls()).toBe(1);
		expect(index.discoveries).toBe(1);
		expect(index.fileParses).toBe(1);
	});

	test("touching a watched input invalidates the snapshot and reruns discovery", async () => {
		const { discover, calls } = stubDiscovery([{ name: "probe", filePath: agentFile }]);
		const index = new AgentDefinitionIndex(discover, () => [watchedFile]);
		await index.lookup("/tmp", "probe");
		await fs.writeFile(watchedFile, "marker: 2\n");
		await index.lookup("/tmp", "probe");
		expect(calls()).toBe(2);
	});

	test("changing the agent definition file re-parses only that file, without rerunning discovery", async () => {
		const { discover, calls } = stubDiscovery([{ name: "probe", filePath: agentFile }]);
		const index = new AgentDefinitionIndex(discover, () => [watchedFile]);
		await index.lookup("/tmp", "probe");
		await fs.writeFile(agentFile, "---\nname: probe\nmodel: opus\n---\nBody\n");
		const facts = await index.lookup("/tmp", "probe");
		expect(facts?.declaredModel).toBe("opus");
		expect(calls()).toBe(1);
		expect(index.fileParses).toBe(2);
	});
});
