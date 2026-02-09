# Peleg Orchestra

WhatsApp Agent Command Center - command Claude Code agents via WhatsApp messages.

## Architecture
- `orchestra.ts` - Main orchestrator: polls WhatsApp, routes messages, spawns/resumes agents
- `agents/registry.json` - Agent state tracking (sessionId, waMessageIds, status)
- `tools/registry.json` - Shared tools built by agents
- `system-prompt.md` - Template injected into each spawned agent

## How It Works
1. Send text to WhatsApp group → new agent spawns, responds in group
2. Reply to agent message → same agent resumes with context
3. Send voice message → transcribed via ElevenLabs, then processed as text
4. Agents run `claude -p` with `bypassPermissions` for full autonomy

## Running
```bash
npm start
```

## Environment
Copy `.env` and set `WA_GROUP_ID` to your WhatsApp group ID.
