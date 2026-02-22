# Peleg Orchestra

WhatsApp + Telegram Agent Command Center - command Claude Code agents via WhatsApp or Telegram messages.

## Architecture
- `orchestra.ts` - Main orchestrator: polls WhatsApp + Telegram, routes messages, spawns/resumes agents
- `agents/registry.json` - Agent state tracking (sessionId, waMessageIds, status)
- `tools/registry.json` - Shared tools built by agents
- `system-prompt.md` - Template injected into each spawned agent

## How It Works
1. Send text to WhatsApp group or Telegram chat → new agent spawns, responds on same channel
2. Reply to agent message → same agent resumes with context
3. Send voice message → transcribed via Groq whisper, then processed as text
4. Agents run `claude -p` with `bypassPermissions` for full autonomy
5. Each agent tracks its channel (`wa` or `tg`) and responds accordingly

## Running
```bash
npm start
```

## Environment
Copy `.env` and set `WA_GROUP_ID` to your WhatsApp group ID.
For Telegram, set `TG_BOT_TOKEN` + `TG_CHAT_ID`. Leave `TG_CHAT_ID` empty to disable.
