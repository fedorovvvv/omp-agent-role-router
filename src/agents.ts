import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgentFrontmatter, parsePluginManifestName } from "./parse";
import type { AgentDefinitionFacts } from "./router";

/** The fields of omp's `AgentDefinition` this extension reads. */
export interface DiscoveredAgent {
	readonly name: string;
	readonly filePath?: string;
	readonly model?: readonly string[];
}

/**
 * omp's own task-agent discovery (`pi.pi.discoverAgents`). Using it instead of
 * re-implementing the precedence rules means the router always looks at the
 * same file omp spawns: project/user `.omp` agents, extension packages,
 * `--plugin-dir` roots, omp- and Claude-installed marketplace plugins,
 * `enabledPlugins`, `enabledProviders`/`disabledProviders`, profiles, XDG.
 */
export type DiscoverAgents = (cwd: string) => Promise<{ readonly agents: readonly DiscoveredAgent[] }>;

interface Snapshot {
	readonly stamp: string;
	readonly watched: readonly string[];
	readonly byName: ReadonlyMap<string, DiscoveredAgent>;
}

interface FileEntry {
	readonly stamp: string;
	readonly model: string | undefined;
}

/** Manifests that name a plugin, in the order omp itself prefers them. */
const PLUGIN_MANIFESTS = [
	path.join(".claude-plugin", "plugin.json"),
	path.join(".omp-plugin", "plugin.json"),
	"plugin.json",
	path.join(".codex-plugin", "plugin.json"),
];

async function statStamp(file: string): Promise<string> {
	try {
		const stats = await fs.stat(file);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "-";
	}
}

async function stampOf(paths: readonly string[]): Promise<string> {
	return (await Promise.all(paths.map(statStamp))).join("|");
}

/**
 * Files and directories whose change can change what `discoverAgents` returns
 * for `cwd`. Directory mtimes cover agent files being added or removed.
 * Nonexistent paths are stamped as missing, so creating one also invalidates.
 */
export function discoveryInputs(
	cwd: string,
	agentDir: string,
	home: string = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
	const ompRoots = new Set([path.dirname(agentDir), path.join(home, ".omp")]);
	const xdgData = env.XDG_DATA_HOME?.trim();
	if (xdgData) {
		ompRoots.add(path.join(xdgData, "omp"));
		const profile = env.OMP_PROFILE?.trim() || env.PI_PROFILE?.trim();
		if (profile) ompRoots.add(path.join(xdgData, "omp", "profiles", profile));
	}
	return [
		path.join(claudeDir, "plugins", "installed_plugins.json"),
		path.join(claudeDir, "settings.json"),
		path.join(cwd, ".claude", "settings.json"),
		path.join(cwd, ".claude", "settings.local.json"),
		path.join(agentDir, "config.yml"),
		path.join(agentDir, "agents"),
		path.join(cwd, ".omp", "config.yml"),
		path.join(cwd, ".omp", "agents"),
		path.join(cwd, ".omp", "plugins", "installed_plugins.json"),
		path.join(cwd, ".omp", "plugins", "omp-plugins.lock.json"),
		...[...ompRoots].flatMap(root => [
			path.join(root, "plugins", "installed_plugins.json"),
			path.join(root, "plugins", "omp-plugins.lock.json"),
		]),
	];
}

/**
 * Answers "which definition does omp spawn for this name, did omp keep its
 * model, and what model does the file declare?" — cheaply. Discovery reruns
 * only when a stamped input (registries, settings, config, agent directories)
 * changed; a definition file is re-read only when its own stamp changed.
 */
export class AgentDefinitionIndex {
	readonly #discover: DiscoverAgents;
	readonly #inputs: (cwd: string) => readonly string[];
	readonly #snapshots = new Map<string, Snapshot>();
	readonly #files = new Map<string, FileEntry>();
	readonly #plugins = new Map<string, string | undefined>();
	#discoveries = 0;
	#fileParses = 0;

	constructor(discover: DiscoverAgents, inputs: (cwd: string) => readonly string[]) {
		this.#discover = discover;
		this.#inputs = inputs;
	}

	/** How many times discovery actually ran (cache misses). */
	get discoveries(): number {
		return this.#discoveries;
	}

	/** How many times a definition file was actually read and parsed (cache misses). */
	get fileParses(): number {
		return this.#fileParses;
	}

	async lookup(cwd: string, name: string): Promise<AgentDefinitionFacts | undefined> {
		const agent = (await this.#snapshot(cwd)).byName.get(name);
		if (!agent?.filePath) return undefined;
		if ((agent.model?.length ?? 0) > 0) return { modelHonoured: true, declaredModel: undefined, plugin: undefined };
		const [declaredModel, plugin] = await Promise.all([
			this.#declaredModel(agent.filePath),
			this.#pluginName(path.dirname(path.dirname(agent.filePath))),
		]);
		return { modelHonoured: false, declaredModel, plugin };
	}

	async #snapshot(cwd: string): Promise<Snapshot> {
		const previous = this.#snapshots.get(cwd);
		if (previous && (await stampOf(previous.watched)) === previous.stamp) return previous;

		const { agents } = await this.#discover(cwd);
		this.#discoveries++;
		const byName = new Map<string, DiscoveredAgent>();
		const agentDirs = new Set<string>();
		for (const agent of agents) {
			if (!byName.has(agent.name)) byName.set(agent.name, agent);
			if (agent.filePath) agentDirs.add(path.dirname(agent.filePath));
		}
		const watched = [...new Set([...this.#inputs(cwd), ...agentDirs])];
		const snapshot: Snapshot = { stamp: await stampOf(watched), watched, byName };
		this.#snapshots.set(cwd, snapshot);
		this.#plugins.clear();
		return snapshot;
	}

	async #declaredModel(filePath: string): Promise<string | undefined> {
		const stamp = await statStamp(filePath);
		const cached = this.#files.get(filePath);
		if (cached?.stamp === stamp) return cached.model;
		this.#fileParses++;
		let model: string | undefined;
		try {
			model = parseAgentFrontmatter(await Bun.file(filePath).text())?.model;
		} catch {
			model = undefined;
		}
		this.#files.set(filePath, { stamp, model });
		return model;
	}

	async #pluginName(root: string): Promise<string | undefined> {
		if (this.#plugins.has(root)) return this.#plugins.get(root);
		let name: string | undefined;
		for (const manifest of PLUGIN_MANIFESTS) {
			try {
				name = parsePluginManifestName(await Bun.file(path.join(root, manifest)).text());
			} catch {
				name = undefined;
			}
			if (name) break;
		}
		this.#plugins.set(root, name);
		return name;
	}
}
