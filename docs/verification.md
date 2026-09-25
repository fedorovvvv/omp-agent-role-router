# Verified with omp 18.3.x

Probe method: a throwaway project directory with `enabledProviders: [claude-plugins]` in
`.omp/config.yml` (needed outside a project that already enables it), then
`omp -p --model <parent> -e src/index.ts "call task with agents …"`, reading `model_change` lines
from `~/.omp/agent/sessions/<cwd-slug>/<parent-session>/<child>.jsonl`.
`OMP_AGENT_ROLE_ROUTER_DEBUG=1` was set to also capture this extension's own decision log.

Parent model for the run: `anthropic/claude-haiku-4-5` (via `--model`). All four spawned as a
single `task` batch from the ForgePlan `agents-core@1.13.0` marketplace plugin (Claude-dialect,
`model:` dropped by omp).

| agent | declared tier (frontmatter) | routed to | resolved model | how |
| --- | --- | --- | --- | --- |
| `guardian` | `opus` | `@default` | `anthropic/claude-haiku-4-5` | this extension |
| `planner` | `sonnet` | `@task` | `anthropic/claude-sonnet-5` | this extension |
| `forge-advisor` | `haiku` | `@smol` | `zai/glm-5.3-flash` | this extension |
| `tester` | `sonnet` | *(untouched)* | `zai/glm-5.3` | `task.agentModelOverrides.tester` (pre-existing) |

Every resolved model in the `model_change` log line matches the table exactly. `guardian`
resolving to `haiku` rather than the configured `modelRoles.default` (`anthropic/claude-opus-5-5`)
is **not** a bug in this extension: `omp --model X` rebinds the `default` role to `X` for that
whole process (`overrideModelRoles({default: X})` — this is documented, deliberate CLI behavior,
not something an extension can or should see around). `tester` was correctly left alone —
`task.agentModelOverrides` still wins outright, per the precedence in `docs/how-it-works.md`.

## Debug log lines (matching run)

```
agent-role-router: left tester untouched
  reason: task.agentModelOverrides has an entry for this agent
  patterns: ["zai/glm-5.3"]

agent-role-router: routed guardian
  note: frontmatter opus → @default
  role: @default
  resolves: anthropic/claude-haiku-4-5

agent-role-router: routed planner
  note: frontmatter sonnet → @task
  role: @task
  resolves: anthropic/claude-sonnet-5

agent-role-router: routed forge-advisor
  note: frontmatter haiku → @smol
  role: @smol
  resolves: zai/glm-5.3-flash
```

## Codex-unreachable probe

The Figma Codex plugin (`~/.codex/plugins/cache/openai-curated-remote/figma`) ships an agent named
`design-parity-review-agent`. The same-id Claude-side install
(`~/.claude/plugins/cache/claude-plugins-official/figma`) has no `agents/` directory at all — this
agent exists only on the Codex side.

```
$ omp -p --model anthropic/claude-haiku-4-5 "Call the task tool with agent 'design-parity-review-agent' and task 'reply OK'."
…
Task DesignParityReply failed preflight: Unknown agent "design-parity-review-agent". Available: forge-advisor, ux-reviewer, …
```

Confirms `docs/how-it-works.md`'s Codex-support claim empirically, not just from source reading.

## Installed-copy probe

After `omp plugin install github:fedorovvvv/omp-agent-role-router` (user scope, no `-e` flag —
the extension loads purely via `package.json`'s `omp.extensions`):

```
$ omp -p --model anthropic/claude-haiku-4-5 "Call the task tool with agent 'guardian' and task 'reply OK'."
```

Debug log (own process, matched by the spawn's `spawnKey`):

```
agent-role-router: routed guardian
  note: frontmatter opus → @default
  role: @default
  resolves: anthropic/claude-haiku-4-5
```

Session `model_change` for the child matches: `anthropic/claude-haiku-4-5`. Confirms the installed
copy — not just `-e`-loaded source — fires the hook and routes correctly.
