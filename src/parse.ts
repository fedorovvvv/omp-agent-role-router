/**
 * Boundary module. Every piece of data this extension reads from disk or from
 * omp's raw settings layers — agent frontmatter, plugin manifests, the
 * `agentRoleRouter` config block, `task.agentModelOverrides` entries — is
 * narrowed into named types here, exactly once. Nothing outside this file
 * inspects `unknown`.
 */

/** A role rule: an omp role alias (`@task`, `@smol:low`) or `false` for "leave the spawn alone". */
export type RoleRule = string | false;

/** Per-plugin rule: `false` skips every agent of the plugin; a map overrides tier rules for it. */
export type PluginRule = false | ReadonlyMap<string, RoleRule>;

/** One `agentRoleRouter` block from one settings layer (user or project). */
export interface RouterConfigLayer {
	readonly enabled?: boolean;
	readonly debug?: boolean;
	/** Keys are lower-cased tier names (`opus`, `gpt-mini`) or exact declared model values. */
	readonly tiers: ReadonlyMap<string, RoleRule>;
	/** Keys are exact agent names (case-sensitive, like omp's own lookup). */
	readonly agents: ReadonlyMap<string, RoleRule>;
	/** Keys are plugin names as declared in the plugin manifest. */
	readonly plugins: ReadonlyMap<string, PluginRule>;
}

export interface ParsedLayer {
	readonly layer: RouterConfigLayer;
	readonly warnings: readonly string[];
}

export const EMPTY_LAYER: RouterConfigLayer = {
	tiers: new Map(),
	agents: new Map(),
	plugins: new Map(),
};

/** The subset of agent frontmatter this extension consumes. */
export interface AgentFrontmatter {
	/** First selector of the `model:` field, trimmed; undefined when absent or empty. */
	readonly model: string | undefined;
}

type Mapping = Readonly<Record<string, unknown>>;

function asMapping(value: unknown): Mapping | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Mapping;
}

const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FLAT_LINE = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/;

/**
 * Parse the leading `---` frontmatter block of an agent markdown file.
 *
 * Mirrors omp's own tolerance: strict YAML first, and when the block is not
 * valid YAML (Claude Code agents often carry unquoted `:` in descriptions) a
 * flat `key: value` line scan, so a sloppy description cannot hide `model:`.
 * Returns undefined when the file has no frontmatter at all.
 */
export function parseAgentFrontmatter(content: string): AgentFrontmatter | undefined {
	const block = FRONTMATTER_BLOCK.exec(content)?.[1];
	if (block === undefined) return undefined;
	let fields: Mapping | undefined;
	try {
		fields = asMapping(Bun.YAML.parse(block));
	} catch {
		fields = undefined;
	}
	const model = fields ? fields.model : scanFlatField(block, "model");
	return { model: firstSelector(model) };
}

function scanFlatField(block: string, key: string): string | undefined {
	for (const line of block.split(/\r?\n/)) {
		const match = FLAT_LINE.exec(line);
		if (match?.[1] !== key) continue;
		return match[2]?.replace(/^(["'])(.*)\1$/, "$2");
	}
	return undefined;
}

/** omp accepts `model` as one selector, a CSV string, or a list; the first entry is the primary. */
function firstSelector(value: unknown): string | undefined {
	const first = Array.isArray(value) ? value.find(entry => typeof entry === "string") : value;
	if (typeof first !== "string") return undefined;
	const selector = first.split(",")[0]?.trim();
	return selector ? selector : undefined;
}

/** Read `name` from a plugin manifest (`.claude-plugin/plugin.json`, `plugin.json`, …). */
export function parsePluginManifestName(text: string): string | undefined {
	let manifest: Mapping | undefined;
	try {
		manifest = asMapping(JSON.parse(text));
	} catch {
		return undefined;
	}
	const name = manifest?.name;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * Whether a `task.agentModelOverrides` value makes core pick a model — the
 * same test core applies (a selector string, CSV, or list with a non-empty
 * entry). An empty entry does not override and must not block routing.
 */
export function isEffectiveModelOverride(value: string | readonly string[] | undefined): boolean {
	const entries = typeof value === "string" ? [value] : (value ?? []);
	return entries.some(entry => entry.split(",").some(part => part.trim() !== ""));
}

const ROLE_ALIAS = /^@[\w.-]+(?::[\w-]+)?$/;

function parseRoleRule(value: unknown, where: string, warnings: string[]): RoleRule | undefined {
	if (value === false) return false;
	if (typeof value === "string" && ROLE_ALIAS.test(value.trim())) return value.trim();
	warnings.push(
		`${where}: expected an omp role alias such as "@task" (optionally "@task:high") or false, got ${JSON.stringify(value)}; concrete models belong in task.agentModelOverrides`,
	);
	return undefined;
}

function parseRuleMap(
	value: unknown,
	where: string,
	warnings: string[],
	keyCase: "lower" | "exact",
): Map<string, RoleRule> {
	const rules = new Map<string, RoleRule>();
	if (value === undefined || value === null) return rules;
	const mapping = asMapping(value);
	if (!mapping) {
		warnings.push(`${where}: expected a mapping, got ${JSON.stringify(value)}`);
		return rules;
	}
	for (const [key, raw] of Object.entries(mapping)) {
		const rule = parseRoleRule(raw, `${where}.${key}`, warnings);
		if (rule !== undefined) rules.set(keyCase === "lower" ? key.trim().toLowerCase() : key.trim(), rule);
	}
	return rules;
}

function parseBoolean(value: unknown, where: string, warnings: string[]): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	warnings.push(`${where}: expected true or false, got ${JSON.stringify(value)}`);
	return undefined;
}

const KNOWN_KEYS: Record<string, true> = { enabled: true, debug: true, tiers: true, agents: true, plugins: true };

/**
 * Narrow one raw `agentRoleRouter` block. Invalid entries are dropped with a
 * warning instead of failing the whole layer, so one typo never disables
 * routing that the rest of the block describes correctly.
 */
export function parseConfigLayer(raw: unknown, origin: string): ParsedLayer {
	if (raw === undefined || raw === null) return { layer: EMPTY_LAYER, warnings: [] };
	const warnings: string[] = [];
	const mapping = asMapping(raw);
	if (!mapping) {
		warnings.push(`${origin}: agentRoleRouter must be a mapping, got ${JSON.stringify(raw)}`);
		return { layer: EMPTY_LAYER, warnings };
	}
	for (const key of Object.keys(mapping)) {
		if (!Object.hasOwn(KNOWN_KEYS, key)) warnings.push(`${origin}: unknown key agentRoleRouter.${key}`);
	}

	const plugins = new Map<string, PluginRule>();
	const rawPlugins = mapping.plugins;
	const pluginMapping = asMapping(rawPlugins);
	if (rawPlugins !== undefined && rawPlugins !== null && !pluginMapping) {
		warnings.push(`${origin}: agentRoleRouter.plugins: expected a mapping, got ${JSON.stringify(rawPlugins)}`);
	}
	for (const [name, value] of Object.entries(pluginMapping ?? {})) {
		const where = `${origin}: agentRoleRouter.plugins.${name}`;
		if (value === false) {
			plugins.set(name.trim(), false);
		} else if (asMapping(value)) {
			plugins.set(name.trim(), parseRuleMap(value, where, warnings, "lower"));
		} else {
			warnings.push(`${where}: expected false or a mapping of tier rules, got ${JSON.stringify(value)}`);
		}
	}

	return {
		layer: {
			enabled: parseBoolean(mapping.enabled, `${origin}: agentRoleRouter.enabled`, warnings),
			debug: parseBoolean(mapping.debug, `${origin}: agentRoleRouter.debug`, warnings),
			tiers: parseRuleMap(mapping.tiers, `${origin}: agentRoleRouter.tiers`, warnings, "lower"),
			agents: parseRuleMap(mapping.agents, `${origin}: agentRoleRouter.agents`, warnings, "exact"),
			plugins,
		},
		warnings,
	};
}
