# @codex-appkit/cli

CLI for the local Agent Harness. It deliberately requires the provider to be
explicit, streams newline-delimited native events, and never starts an
interactive approval flow.

```bash
agent-harness run "summarize this repo" --provider codex --cwd "$PWD"
agent-harness run "summarize this repo" --provider claude --cwd "$PWD"
agent-harness plugin install example --provider claude --scope project
agent-harness http serve --cwd "$PWD" --static ./dist
```
