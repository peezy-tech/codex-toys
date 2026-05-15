# @peezy.tech/codex-opencode-go-router

Internal workspace package providing a local Responses API router for using Codex with models served by OpenCode Go.

Codex currently requires a Responses API provider. OpenCode Go exposes DeepSeek V4 through OpenAI-compatible Chat Completions:

```text
https://opencode.ai/zen/go/v1/chat/completions
```

This router adapts:

- Codex `POST /v1/responses` requests to OpenCode Go Chat Completions.
- Codex Responses tool specs to Chat Completions `tools`.
- Chat Completions `tool_calls` back to Codex Responses output items.
- DeepSeek `reasoning_content` replay across tool-call follow-up requests.

## Requirements

- Node.js 22+ or Bun.
- `OPENCODE_GO_API_KEY` in the environment, or in `~/.env`.

## Run

```bash
bun run --filter @peezy.tech/codex-opencode-go-router start
```

Default endpoint:

```text
http://127.0.0.1:61973/v1
```

Health check:

```bash
curl -fsS http://127.0.0.1:61973/health
```

## Codex Config

Add the contents of `examples/codex.config.toml` to the target `config.toml`, or use a separate Codex home:

```bash
mkdir -p ~/.codex-opencode-go
$EDITOR ~/.codex-opencode-go/config.toml
CODEX_HOME=~/.codex-opencode-go codex --profile deepseek-v4-opencode
```

## Systemd User Service

```bash
mkdir -p ~/.config/systemd/user
cp packages/codex-opencode-go-router/examples/opencode-go-responses-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-go-responses-proxy.service
```

## Test

```bash
bun run --filter @peezy.tech/codex-opencode-go-router check
bun run --filter @peezy.tech/codex-opencode-go-router test
```

The self-test starts a fake OpenCode Go upstream and verifies plain messages, function calls, namespace calls, custom/freeform calls, local shell calls, tool-search calls, DeepSeek reasoning replay, and history replay.

## Development

See `DEVELOP.md`. This package is private and is not included in
the public npm publish workflow.
