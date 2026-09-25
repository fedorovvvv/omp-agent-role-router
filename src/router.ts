import type { RouterConfig } from "./config";
import type { RoleRule } from "./parse";
import { classifyDeclaredModel } from "./tiers";

/** What is known about the definition omp resolves for the spawned agent name. */
export interface AgentDefinitionFacts {
	/**
	 * omp kept this definition's own `model:` (native `.omp` agent, OMP or
	 * Agent-Plugins-format plugin), so core already honours it.
	 */
	readonly modelHonoured: boolean;
	/** First `model:` selector written in the definition file, if any. */
	readonly declaredModel: string | undefined;
	/** Name from the plugin manifest next to the definition's `agents/` directory. */
	readonly plugin: string | undefined;
}

/** The spawn-time facts the routing decision depends on. */
export interface SpawnFacts {
	readonly agent: string;
	/** `before_subagent_spawn.modelRole`: set when core already resolved a role alias. */
	readonly modelRole: string | undefined;
	/** `before_subagent_spawn.patterns`: the patterns core would spawn with. */
	readonly patterns: readonly string[];
	/** The parent session's live model as `provider/id`. */
	readonly currentModel: string | undefined;
	/** `task.agentModelOverrides` has an effective entry for this agent. */
	readonly hasModelOverride: boolean;
}

/** Resolves the definition omp spawns for `SpawnFacts.agent`; only called when the spawn could be routed. */
export type DefinitionLookup = () => Promise<AgentDefinitionFacts | undefined>;

export type Decision =
	| { readonly action: "route"; readonly role: string; readonly note: string }
	| { readonly action: "skip"; readonly reason: string };

/**
 * A spawn "inherits" when core's only pattern is the parent's live model —
 * the signature of a definition whose `model:` omp dropped. The pattern may
 * carry a `:level` suffix; the current model never does.
 */
export function inheritsParentModel(patterns: readonly string[], currentModel: string): boolean {
	const [only] = patterns;
	return patterns.length === 1 && only !== undefined && (only === currentModel || only.startsWith(`${currentModel}:`));
}

/**
 * Decide whether to give a spawn an omp role. Everything that already chose
 * a model — a per-call model, `task.agentModelOverrides`, a frontmatter role
 * or selector omp honours — wins over the router; unknown input leaves the
 * spawn untouched. The definition is looked up only after the cheap checks
 * pass, so spawns the router must not touch never hit the filesystem.
 */
export async function decide(spawn: SpawnFacts, config: RouterConfig, lookup: DefinitionLookup): Promise<Decision> {
	const skip = (reason: string): Decision => ({ action: "skip", reason });
	if (!config.enabled) return skip("agentRoleRouter.enabled is false");
	if (spawn.modelRole !== undefined) return skip(`spawn already resolves role @${spawn.modelRole}`);
	if (spawn.hasModelOverride) return skip("task.agentModelOverrides has an entry for this agent");
	if (!spawn.currentModel) return skip("parent session has no active model");
	if (!inheritsParentModel(spawn.patterns, spawn.currentModel)) {
		return skip(`spawn already has its own model (${spawn.patterns.join(", ") || "none"})`);
	}
	const definition = await lookup();
	if (!definition) return skip("no agent definition file resolves for this name");
	if (definition.modelHonoured) return skip("omp honours this definition's own model");

	const agentRule = config.agents.get(spawn.agent);
	if (agentRule === false) return skip(`agentRoleRouter.agents.${spawn.agent} is false`);
	if (agentRule !== undefined) {
		return { action: "route", role: agentRule, note: `agentRoleRouter.agents.${spawn.agent} → ${agentRule}` };
	}

	const declared = definition.declaredModel;
	if (declared === undefined) return skip("definition declares no model");
	const exactKey = declared.toLowerCase();
	if (exactKey === "inherit") return skip("definition declares model: inherit");
	const pluginRules = definition.plugin === undefined ? undefined : config.plugins.get(definition.plugin);
	if (pluginRules === false) return skip(`agentRoleRouter.plugins.${definition.plugin} is false`);

	const tier = classifyDeclaredModel(declared);
	const keys = tier && tier.tier !== exactKey ? [exactKey, tier.tier] : [exactKey];
	const scopes: ReadonlyArray<readonly [string, ReadonlyMap<string, RoleRule> | undefined]> = [
		[`plugins.${definition.plugin}`, pluginRules],
		["tiers", config.tiers],
	];
	for (const [scope, rules] of scopes) {
		for (const key of keys) {
			const rule = rules?.get(key);
			if (rule === undefined) continue;
			if (rule === false) return skip(`agentRoleRouter.${scope}.${key} is false`);
			const via = key === exactKey ? "" : ` (${key})`;
			const where = scope === "tiers" ? "" : ` [${scope}]`;
			return { action: "route", role: rule, note: `frontmatter ${declared}${via} → ${rule}${where}` };
		}
	}
	return skip(tier ? `no role configured for tier ${tier.tier}` : `unrecognised model "${declared}"`);
}
