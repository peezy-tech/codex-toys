---
title: Workspace voice gateway
description: Broadcast-only Discord voice output for Codex workspace backend updates.
---

# Workspace voice gateway

`codex-workspace-voice-gateway` is a small broadcast-only Discord gateway
package/app built on `@peezy.tech/codex-flows`. It keeps a Discord bot connected
to one configured voice channel, observes a selected Codex workspace backend,
and speaks concise workspace updates through a TTS worker.

It does not receive voice commands, run speech-to-text, or replace the Discord
text bridge.

## Run it

Install the gateway package:

```bash
bun add @peezy.tech/codex-workspace-voice-gateway
```

Start the TTS worker from the sibling speech repo:

```bash
cd ../tts
uv run tts-worker
```

Start a workspace backend:

```bash
codex-workspace-backend-local serve --local-app-server
```

Run the gateway:

```bash
codex-workspace-voice-gateway \
	--workspace-backend-url ws://127.0.0.1:3586 \
	--tts-worker-url http://127.0.0.1:8000
```

Or run the local persistent stack through `mprocs` from the repo root:

```bash
bun run voice:up
```

Required Discord configuration:

| Variable | Purpose |
|----------|---------|
| `CODEX_VOICE_DISCORD_BOT_TOKEN`, `CODEX_DISCORD_BOT_TOKEN`, or `DISCORD_BOT_TOKEN` | Discord bot token. |
| `CODEX_VOICE_DISCORD_VOICE_CHANNEL_ID`, `CODEX_GATEWAY_DISCORD_VOICE_CHANNEL_ID`, or `DISCORD_VOICE_CHANNEL_ID` | Voice channel id. |

Common optional configuration:

| Variable | Purpose |
|----------|---------|
| `CODEX_VOICE_WORKSPACE_BACKEND_WS_URL`, `CODEX_WORKSPACE_BACKEND_WS_URL`, or `CODEX_GATEWAY_BACKEND_URL` | Workspace backend WebSocket URL. |
| `CODEX_VOICE_TTS_WORKER_URL` or `DISCORD_TTS_WORKER_URL` | TTS worker HTTP URL. |
| `CODEX_VOICE_TTS_REFERENCE_AUDIO_PATH` or `DISCORD_TTS_REFERENCE_AUDIO_PATH` | Reference voice audio path. |
| `CODEX_VOICE_TTS_REFERENCE_TEXT` or `DISCORD_TTS_REFERENCE_TEXT` | Reference voice transcript. |
| `CODEX_VOICE_TTS_REFERENCE_TEXT_PATH` or `DISCORD_TTS_REFERENCE_TEXT_PATH` | Reference transcript file. |
| `CODEX_VOICE_DISCORD_GUILD_ID`, `CODEX_DISCORD_GUILD_ID`, or `DISCORD_GUILD_ID` | Optional Discord guild id. The gateway can infer it from the voice channel. |
| `CODEX_VOICE_ANNOUNCER_ENABLED=1` | Use a constrained Codex announcer turn for turn-end polish. |
| `CODEX_VOICE_ANNOUNCER_MODEL` | Announcer model. Defaults to `gpt-5.3-codex-spark`. |
| `CODEX_VOICE_MAX_PHRASE_CHARS` | Announcer model target/max phrase length. Defaults to `260`. |

Use `--dry-run` to log announcements without joining Discord or calling TTS.
HTTP(S) backend URLs are accepted and normalized to WS(S).

The `mprocs.voice.yaml` stack starts three local processes:

- `workspace-backend`, using the port from `CODEX_VOICE_WORKSPACE_BACKEND_WS_URL`,
  `CODEX_WORKSPACE_BACKEND_WS_URL`, or `CODEX_GATEWAY_BACKEND_URL`.
- `tts-worker`, from the sibling `../tts` repo with CPU-friendly NeuTTS GGUF
  defaults and the `references/jo.*` voice sample.
- `workspace-voice-gateway`, which waits for the backend socket and TTS health
  endpoint before joining Discord voice.

The stack sources `.env` and then `.env.local`, so machine-local voice channel
overrides can stay out of git.

## External CLI turns

The gateway also watches the Codex hook spool used by the Discord bridge. This
lets it announce `Stop` events from regular Codex CLI sessions that did not run
through the workspace backend. It reads the spool without moving or archiving
files, so the Discord bridge remains the owner of hook draining and return
policy.

Default spool lookup:

| Variable | Purpose |
|----------|---------|
| `CODEX_VOICE_OBSERVE_HOOK_SPOOL=0` | Disable hook-spool observation. |
| `CODEX_VOICE_HOOK_SPOOL_DIR` or `CODEX_DISCORD_HOOK_SPOOL_DIR` | Override the hook spool root. Defaults to `~/.codex/discord-bridge/stop-hooks`. |

Only new hook files created after the gateway starts are announced. Existing
pending files are skipped to avoid replaying stale CLI history on restart.

## Event Policy

The gateway subscribes to workspace backend WebSocket events. It speaks backend
connection/errors, failed hook runs, app-server warnings, and completed turns.
Turn-start announcements are disabled by default because they are noisy; enable
them with `CODEX_VOICE_ANNOUNCE_TURN_STARTED=1` or `--announce-turn-started`.

Turn-end text is cleaned for speech: markdown, URLs, code fences, Discord
mentions, long hashes, and repeated whitespace are removed or compacted. The
gateway does not mechanically truncate cleaned announcements.

Discord playback uses the TTS worker's full synthesis endpoint, writes a
temporary WAV, converts it to Discord-ready PCM, and then plays that completed
audio file. It does not use the worker's streaming endpoint for announcements.
Because the synthesis endpoint returns a file path, the gateway and TTS worker
must run on the same host or share the output filesystem.

## Announcer Model

When enabled, the gateway opens a separate ephemeral announcer thread through the
same workspace backend. That thread receives sanitized turn-completion data and
must return strict JSON:

```json
{
  "speak": true,
  "priority": "normal",
  "text": "The release check finished. Type checks passed, but publishing is still blocked by a missing token."
}
```

The announcer runs with low reasoning by default, read-only sandboxing, no dynamic
tools, and no environment access. Its own thread id is ignored by the voice
gateway so it cannot announce itself.

## Boundary

This app is output-only. Do not add speech-to-text or voice command routing here.
Voice input belongs in a separate gateway if needed later.
