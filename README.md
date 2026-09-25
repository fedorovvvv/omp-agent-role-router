# omp-agent-role-router

An [omp](https://github.com/can1357/oh-my-pi) extension that gives Claude Code plugin subagents
back a sensible model.

## The problem

omp drops the `model:` field of agents that come from Claude Code marketplace plugins (`opus`,
`sonnet`, `haiku` in their frontmatter). Without that field, a subagent has no model of its own —
it just runs on whatever model your main session happens to be on right now, including a mid-turn
retry fallback. A `haiku`-tier agent can end up burning `opus`. A `sonnet`-tier reviewer can end up
running on your session's accidental Codex fallback.

|  | without this extension | with this extension |
| --- | --- | --- |
| `guardian` (`opus`) | whatever your session is on | `@default` |
| `planner` (`sonnet`) | whatever your session is on | `@task` |
| `forge-advisor` (`haiku`) | whatever your session is on | `@smol` |

It reads each agent's own declared tier and gives it an omp **role** (`@default`, `@task`, `@smol`,
…) instead — never a concrete model. What that role actually resolves to is still entirely up to
your own `modelRoles`.

## Install

```sh
omp plugin install github:fedorovvvv/omp-agent-role-router
```

No build step, nothing else to configure. It works immediately.

## Default mapping

| declared tier | routed to |
| --- | --- |
| `opus` | `@default` |
| `sonnet` | `@task` |
| `haiku` | `@smol` |
| `gpt-flagship` (Codex `sol`/`astra`/…) | `@default` |
| `gpt-mid` (Codex `terra`/`*-codex`) | `@task` |
| `gpt-mini` (Codex `luna`/`*-mini`/`*-nano`) | `@smol` |

## Configuration

Zero-config already does the right thing. To change it, add an `agentRoleRouter` block to
`~/.omp/agent/config.yml` or `<project>/.omp/config.yml`:

```yaml
agentRoleRouter:
  tiers:
    opus: "@slow" # change what a whole tier routes to
  agents:
    guardian: "@slow" # override one specific agent by name
    noisy-agent: false # leave this one alone, whatever its tier
  plugins:
    some-plugin: false # leave every agent of this plugin alone
```

An explicit per-call model always wins, and so does an existing
`task.agentModelOverrides` entry — this extension only ever touches a spawn that would otherwise
silently inherit your session's current model with no model of its own.

## Limitations

- Codex's own subagents and plugin agents can't be spawned by omp 18.3 at all — this extension
  can't route what omp can't reach.
- A spawn this extension routes can lose that role's own retry-fallback chain, due to an omp
  behavior described in [`docs/upstream-fallback-bug.md`](docs/upstream-fallback-bug.md).
- A model id this extension doesn't recognize is left untouched, not guessed.

## Details

- [How it works](docs/how-it-works.md) — the decision flow, full config reference, Codex support,
  FAQ.
- [Verification](docs/verification.md) — live probes against a real omp 18.3.0 install.
- [Upstream bug](docs/upstream-fallback-bug.md) — the retry-fallback-chain issue above, traced to
  source.
- [Contributing](CONTRIBUTING.md)

## Development

```sh
bun install
bun run typecheck
bun test
```

## License

MIT © Nikita Fedorov
