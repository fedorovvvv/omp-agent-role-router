# A real omp behavior worth reporting upstream

**A `before_subagent_spawn` hook's returned role-alias `model` does not carry its role identity
into retry-fallback-chain selection**, contradicting the extensions.md doc text ("A returned
`model` replaces the spawn's attempt-ordered patterns while keeping the original role identity, so
the remaining entries become the child's retry fallback chain").

## Root cause, traced to source

`task/structured-subagent.ts`'s `applySpawnHook`:

```ts
const replacement = resolveConfiguredModelPatterns(spawnResult.model, request.session.settings);
if (replacement.length === 0) return policy;
return { ...policy, modelOverride: replacement, modelRoute: spawnResult.note };
```

`spawnResult.model` (`"@task"`, in this extension's case) is expanded to concrete patterns
immediately and only `modelOverride`/`modelRoute` are updated — `policy.modelRole` (computed once,
*before* the hook runs, from the pre-hook patterns) is never refreshed from the hook's own role
identity.

Downstream, `runSubagent` (`task/executor.ts`) infers the retry-fallback chain from:

```ts
modelRole ?? resolveExplicitModelRole(modelPatterns, subagentSettings)
```

But by then `modelPatterns` is also the already-expanded concrete list (no `@` prefix left for
`resolveExplicitModelRole` to find), so the inference falls through to
`retry.fallbackChains.default` regardless of which role the hook actually chose.

## Reproduced live

Verification run's `retry.fallbackChains`:

```yaml
task: [gpt-5.6-terra, glm-5.3]
smol: [claude-haiku-4-5, gpt-6-luna]
default: [opus-5-5, sonnet-5, gpt-5.6-sol, gpt-6-astra]
```

The parent session itself hit a transient Anthropic failure and fell back from `claude-haiku-4-5`
to `openai-codex/gpt-5.6-sol` (`default[2]`) before dispatching the batch. Every child inherited
that live model as its starting pattern, then — on its own first-call failure — **every child's
retry landed on `openai-codex/gpt-5.6-sol` too**, including:

- `planner` (routed to `@task`, whose own chain is `[gpt-5.6-terra, glm-5.3]` — neither of which is
  `gpt-5.6-sol`)
- `forge-advisor` (routed to `@smol`, whose own chain is `[claude-haiku-4-5, gpt-6-luna]` — again,
  neither is `gpt-5.6-sol`)

`guardian` (routed to `@default`) landed on the *correct* chain only because its target role and
the process's rebound default role were the same thing.

This matches exactly what the design brief's own prototype probe had flagged: "when a spawn is
re-routed by a hook, retry fallback seemed to use the default chain rather than the target role's
chain." Confirmed here at the source level, not just observed behaviorally.

## Why this isn't worked around here

There is no available seam for a hook to also correct the retry-chain role identity it changed —
`before_subagent_spawn`'s result shape (`BeforeSubagentSpawnEventResult`) has no `modelRole` field,
only `model`, `block`, `reason`, `note`. This is a limitation of omp's hook API, not of this
extension. Filed for awareness; not worked around here.
