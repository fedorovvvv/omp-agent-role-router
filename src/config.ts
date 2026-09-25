import { type PluginRule, parseConfigLayer, type RoleRule, type RouterConfigLayer } from "./parse";

/** Top-level key of this extension's block in omp's `config.yml` layers. */
export const CONFIG_KEY = "agentRoleRouter";

export interface RouterConfig {
	readonly enabled: boolean;
	readonly debug: boolean;
	readonly tiers: ReadonlyMap<string, RoleRule>;
	readonly agents: ReadonlyMap<string, RoleRule>;
	readonly plugins: ReadonlyMap<string, PluginRule>;
}

/**
 * Zero-config tier map. Roles, never models: what `@default` / `@task` /
 * `@smol` resolve to stays governed by the user's `modelRoles`.
 */
export const DEFAULT_TIERS: ReadonlyMap<string, RoleRule> = new Map<string, RoleRule>([
	["opus", "@default"],
	["sonnet", "@task"],
	["haiku", "@smol"],
	["gpt-flagship", "@default"],
	["gpt-mid", "@task"],
	["gpt-mini", "@smol"],
]);

export const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	debug: false,
	tiers: DEFAULT_TIERS,
	agents: new Map(),
	plugins: new Map(),
};

function mergePluginRules(
	base: ReadonlyMap<string, PluginRule>,
	overlay: ReadonlyMap<string, PluginRule>,
): Map<string, PluginRule> {
	const merged = new Map(base);
	for (const [name, rule] of overlay) {
		const previous = merged.get(name);
		merged.set(name, rule && previous ? new Map([...previous, ...rule]) : rule);
	}
	return merged;
}

/** Later layers win key by key; a plugin's tier rules merge unless a layer sets the plugin to `false`. */
export function mergeLayers(layers: readonly RouterConfigLayer[]): RouterConfig {
	return layers.reduce<RouterConfig>(
		(config, layer) => ({
			enabled: layer.enabled ?? config.enabled,
			debug: layer.debug ?? config.debug,
			tiers: new Map([...config.tiers, ...layer.tiers]),
			agents: new Map([...config.agents, ...layer.agents]),
			plugins: mergePluginRules(config.plugins, layer.plugins),
		}),
		DEFAULT_CONFIG,
	);
}

export interface LoadedConfig {
	readonly config: RouterConfig;
	readonly warnings: readonly string[];
}

/**
 * Build the effective config from the `agentRoleRouter` blocks of omp's raw
 * settings layers: built-in defaults, then the user `config.yml`, then the
 * project `.omp/config.yml`.
 */
export function loadConfig(userBlock: unknown, projectBlock: unknown): LoadedConfig {
	const user = parseConfigLayer(userBlock, "user config.yml");
	const project = parseConfigLayer(projectBlock, "project .omp/config.yml");
	return {
		config: mergeLayers([user.layer, project.layer]),
		warnings: [...user.warnings, ...project.warnings],
	};
}
