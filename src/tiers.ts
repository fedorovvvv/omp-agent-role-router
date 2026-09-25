/**
 * Classify the model a foreign agent declares into a tier key.
 *
 * Claude Code vocabulary: `opus | sonnet | haiku | best`, `opus[1m]`, full ids
 * (`claude-sonnet-4-5`, `claude-3-5-haiku-20241022`), provider-qualified and
 * Bedrock/Vertex spellings (`anthropic/claude-opus-4-5`,
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, `claude-opus-4-1@20250805`).
 * The tier key is the Claude family token (`opus`, `sonnet`, `haiku`, and any
 * newer family such as `fable` — routed only if the config maps it).
 *
 * OpenAI / Codex vocabulary: `gpt-5.5`, `gpt-5.6-sol`, `gpt-6-astra`,
 * `gpt-5.6-terra`, `gpt-5.3-codex`, `gpt-5.1-codex-mini`, `gpt-6-luna`,
 * `o3`, `o4-mini`, `codex-mini-latest`. Three tier keys:
 *   - `gpt-mini`     — `mini`, `nano`, `luna` qualifiers
 *   - `gpt-flagship` — bare `gpt-N[.M]` / `oN`, or `sol`, `astra`, `pro`, `max`
 *   - `gpt-mid`      — `terra` or `codex` qualifiers
 * Any other qualifier (`gpt-oss-120b`, `gpt-4o-audio`) is unknown on purpose:
 * an unrecognised model leaves the spawn untouched instead of being guessed.
 */

export type ModelFamily = "claude" | "openai";

export interface DeclaredTier {
	readonly family: ModelFamily;
	/** Key looked up in `agentRoleRouter.tiers`. */
	readonly tier: string;
}

const CLAUDE_ALIASES: Record<string, string> = {
	opus: "opus",
	sonnet: "sonnet",
	haiku: "haiku",
	best: "opus",
};

/** `claude-<family>…` or legacy `claude-<major>-<minor>-<family>…`, optionally after a `vendor.` prefix. */
const CLAUDE_ID = /(?:^|\.)claude-(?:\d+(?:-\d+)*-)?([a-z]+)/;
/** `gpt-<version>[-qualifiers]`, `o<N>[-qualifiers]`, `codex[-qualifiers]`. */
const OPENAI_ID = /^(?:gpt-\d+(?:\.\d+)?o?|o\d+|(codex))(?:-(.+))?$/;
/** Qualifier tokens that carry no tier signal: release dates, snapshot numbers, channels. */
const NEUTRAL_QUALIFIER = /^(?:\d+|latest|preview)$/;

const SMALL_QUALIFIERS: Record<string, true> = { mini: true, nano: true, luna: true };
const FLAGSHIP_QUALIFIERS: Record<string, true> = { sol: true, astra: true, pro: true, max: true };
const MID_QUALIFIERS: Record<string, true> = { terra: true, codex: true };

/** Reduce a declared value to a bare lower-case model id. */
export function normalizeModelId(declared: string): string {
	let id = declared.trim().toLowerCase();
	id = id.replace(/\[[^\]]*\]$/, ""); // opus[1m], sonnet[1m]
	id = id.slice(id.lastIndexOf("/") + 1); // provider/model
	id = id.replace(/@.*$/, ""); // Vertex snapshot: claude-opus-4-1@20250805
	id = id.replace(/:[\w.-]*$/, ""); // thinking level or Bedrock revision: …:high, …-v1:0
	return id;
}

export function classifyDeclaredModel(declared: string): DeclaredTier | undefined {
	const id = normalizeModelId(declared);
	if (!id) return undefined;

	const alias = Object.hasOwn(CLAUDE_ALIASES, id) ? CLAUDE_ALIASES[id] : undefined;
	if (alias) return { family: "claude", tier: alias };
	const claudeFamily = CLAUDE_ID.exec(id)?.[1];
	if (claudeFamily) return { family: "claude", tier: claudeFamily };

	const openai = OPENAI_ID.exec(id);
	if (!openai) return undefined;
	const isCodexLine = openai[1] !== undefined;
	const qualifiers = (openai[2] ?? "").split("-").filter(token => token && !NEUTRAL_QUALIFIER.test(token));
	const has = (table: Record<string, true>): boolean => qualifiers.some(token => Object.hasOwn(table, token));

	if (has(SMALL_QUALIFIERS)) return { family: "openai", tier: "gpt-mini" };
	if (has(FLAGSHIP_QUALIFIERS)) return { family: "openai", tier: "gpt-flagship" };
	if (has(MID_QUALIFIERS) || (isCodexLine && qualifiers.length === 0)) return { family: "openai", tier: "gpt-mid" };
	if (qualifiers.length === 0) return { family: "openai", tier: "gpt-flagship" };
	return undefined;
}
