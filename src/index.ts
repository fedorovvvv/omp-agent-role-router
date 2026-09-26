/**
 * omp-agent-role-router — give foreign subagents an omp model role.
 *
 * omp drops the `model:` of agents shipped by Claude Code-format plugins, so
 * they inherit whatever model the parent session runs at spawn time. At
 * `before_subagent_spawn` this extension reads the definition omp resolved,
 * maps its declared tier (`opus`, `sonnet`, `haiku`, `gpt-5.6-luna`, …) onto an
 * omp role (`@default`, `@task`, `@smol`, …) and returns that role — never a
 * concrete model — so `modelRoles` keeps deciding what actually runs.
 */
import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentDefinitionIndex, discoveryInputs } from "./agents";
import { CONFIG_KEY, loadConfig } from "./config";
import { isEffectiveModelOverride } from "./parse";
import { decide } from "./router";

/** Set to `1` to log every routing decision to omp's log file, like `agentRoleRouter.debug: true`. */
export const DEBUG_ENV = "OMP_AGENT_ROLE_ROUTER_DEBUG";
const LOG_PREFIX = "agent-role-router";

export default function agentRoleRouter(pi: ExtensionAPI): void {
	const sdk = pi.pi;
	const index = new AgentDefinitionIndex(
		cwd => sdk.discoverAgents(cwd),
		cwd => discoveryInputs(cwd, sdk.getAgentDir()),
	);
	const reported = new Set<string>();

	const warnOnce = (message: string, ctx: ExtensionContext): void => {
		if (reported.has(message)) return;
		reported.add(message);
		pi.logger.warn(`${LOG_PREFIX}: ${message}`);
		if (ctx.hasUI) ctx.ui.notify(`${LOG_PREFIX}: ${message}`, "warning");
	};

	pi.on("before_subagent_spawn", async (event, ctx) => {
		const settings: Settings | undefined = findScopedSettings();
		if (!settings) {
			warnOnce("omp settings are unavailable, routing is off for this session", ctx);
			return undefined;
		}
		const { config, warnings } = loadConfig(
			settings.getGlobalSettings()[CONFIG_KEY],
			settings.getProjectSettings()[CONFIG_KEY],
		);
		for (const warning of warnings) warnOnce(warning, ctx);
		const debug = config.debug || process.env[DEBUG_ENV] === "1";

		const configuredOverrides = lookup("task.agentModelOverrides")?.get(settings);
		const overrides = configuredOverrides && typeof configuredOverrides === "object" && !Array.isArray(configuredOverrides)
			? (configuredOverrides as Record<string, unknown>)
			: {};
		const current = ctx.models.current();
		// In a headless SDK session this hook can fire before ExtensionContext knows the current
		// model, while `patterns` already holds the parent's inherited choice. A single pattern is
		// the only reliable fallback; several stay unknown so a retry chain is never mistaken for
		// the inherited state.
		const currentModel = current
			? `${current.provider}/${current.id}`
			: event.patterns.length === 1
				? event.patterns[0]
				: undefined;
		const decision = await decide(
			{
				agent: event.agent,
				modelRole: event.modelRole,
				patterns: event.patterns,
				currentModel,
				hasModelOverride: isEffectiveModelOverride(asOverride(Object.hasOwn(overrides, event.agent) ? overrides[event.agent] : undefined)),
			},
			config,
			() => index.lookup(ctx.cwd, event.agent),
		);

		if (decision.action === "skip") {
			if (debug) pi.logger.debug(`${LOG_PREFIX}: left ${event.agent} untouched`, { reason: decision.reason, event });
			return undefined;
		}
		// `resolveConfiguredModelPatterns()` resolves the role again against the child session's
		// settings after the event. ExtensionContext.models is a snapshot of the parent's request
		// facade and may lack a role defined only in this session's isolated overlay; returning the
		// role leaves the final decision to the child's authoritative resolver.
		if (debug) {
			pi.logger.debug(`${LOG_PREFIX}: routed ${event.agent}`, {
				note: decision.note,
				role: decision.role,
				event,
			});
		}
		return { model: decision.role, note: decision.note };
	});
}

/** A `task.agentModelOverrides` value only counts when it has the shape omp accepts. */
function asOverride(value: unknown): string | readonly string[] | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every(entry => typeof entry === "string")) return value as readonly string[];
	return undefined;
}
