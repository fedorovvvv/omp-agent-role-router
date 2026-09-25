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
		let settings: Settings;
		try {
			settings = sdk.Settings.instance;
		} catch (error) {
			warnOnce(`omp settings are unavailable, routing is off for this session (${String(error)})`, ctx);
			return undefined;
		}
		const { config, warnings } = loadConfig(
			settings.getGlobalSettings()[CONFIG_KEY],
			settings.getProjectSettings()[CONFIG_KEY],
		);
		for (const warning of warnings) warnOnce(warning, ctx);
		const debug = config.debug || process.env[DEBUG_ENV] === "1";

		const overrides = settings.get("task.agentModelOverrides");
		const current = ctx.models.current();
		const decision = await decide(
			{
				agent: event.agent,
				modelRole: event.modelRole,
				patterns: event.patterns,
				currentModel: current ? `${current.provider}/${current.id}` : undefined,
				hasModelOverride: isEffectiveModelOverride(
					Object.hasOwn(overrides, event.agent) ? overrides[event.agent] : undefined,
				),
			},
			config,
			() => index.lookup(ctx.cwd, event.agent),
		);

		if (decision.action === "skip") {
			if (debug) pi.logger.debug(`${LOG_PREFIX}: left ${event.agent} untouched`, { reason: decision.reason, event });
			return undefined;
		}
		const target = ctx.models.resolve(decision.role);
		if (!target) {
			warnOnce(
				`${decision.role} (${decision.note}) resolves to no available model; ${event.agent} keeps the inherited model`,
				ctx,
			);
			return undefined;
		}
		if (debug) {
			pi.logger.debug(`${LOG_PREFIX}: routed ${event.agent}`, {
				note: decision.note,
				role: decision.role,
				resolves: `${target.provider}/${target.id}`,
				event,
			});
		}
		return { model: decision.role, note: decision.note };
	});
}
