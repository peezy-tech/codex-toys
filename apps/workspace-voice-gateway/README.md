# @peezy.tech/codex-workspace-voice-gateway

Broadcast-only Discord voice gateway for Codex workspace backend updates.

```bash
bun add @peezy.tech/codex-workspace-voice-gateway
```

Run it beside a workspace backend and a TTS worker:

```bash
codex-workspace-backend-local serve --local-app-server
codex-workspace-voice-gateway \
	--workspace-backend-url ws://127.0.0.1:3586 \
	--tts-worker-url http://127.0.0.1:8000
```

This package is a channel-specific gateway. It depends on
`@peezy.tech/codex-flows` for the workspace backend protocol and keeps Discord
voice/TTS dependencies outside the core package.

Full reference docs live in
`docs/pages/reference/workspace-voice-gateway.md` in the source repository.
