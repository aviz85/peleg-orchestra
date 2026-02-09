# Peleg Orchestra

A WhatsApp-based command center for orchestrating Claude Code agents. Send a message to a WhatsApp group and a Claude Code agent spawns to handle it. Reply to an agent's message and it resumes with full context. Send a voice message and it gets transcribed and processed automatically.

<img src="screenshot.png" alt="Yam Peleg's original WhatsApp agent system" width="400">

## Inspiration

This project is inspired by [Yam Peleg's tweet](https://x.com/Yampeleg/status/2020624600246481263) demonstrating a WhatsApp group where you command Claude Code agents via messages.

**This project was built entirely as an experiential exercise and is provided as-is. It is not coordinated with, endorsed by, or affiliated with Yam Peleg in any way. Yam Peleg bears no responsibility for this project or its use. Use entirely at your own risk.**

## How It Works

```
WhatsApp Group
      ↕  (notification queue via Green API)
  orchestra.ts
      ↕
  ┌───┴────┐
  │ Router │
  └───┬────┘
      ├── Reply?  → find agent by quoted message → resume session
      ├── Voice?  → download → transcribe → process as text
      └── New?    → spawn new Claude Code agent
```

1. **New message** → 👀 reaction → spawns a new `claude -p` agent → ⚡ reaction while working → responds in group
2. **Reply to agent** → resumes that agent's session via `claude -p --resume`
3. **Voice message** → downloaded, transcribed via Groq whisper-large-v3, then processed as text
4. **Agent output** → sent back to the WhatsApp group, tagged with the agent ID
5. **Reply routing** → each sent message ID is tracked, so replies route back to the correct agent

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally
- A [Green API](https://green-api.com/) account with an active WhatsApp instance
- (Optional) A [Groq](https://console.groq.com/) API key for voice transcription

## Installation

You can ask your Claude Code agent to set this up for you:

> "Clone peleg-orchestra repo, create the .env from .env.example, fill in my Green API credentials, create a WhatsApp group, and start the orchestrator"

Or manually:

```bash
git clone https://github.com/YOUR_USERNAME/peleg-orchestra.git
cd peleg-orchestra
npm install
cp .env.example .env
# Edit .env with your credentials
npm start
```

### Setting up Green API

1. Sign up at [green-api.com](https://green-api.com/)
2. Create a new instance and link your WhatsApp
3. Copy the instance ID and API token to your `.env`
4. Create a WhatsApp group (or use the Green API `createGroup` endpoint)
5. Set the group ID in `WA_GROUP_ID`

### Setting up Groq (optional, for voice)

1. Sign up at [console.groq.com](https://console.groq.com/)
2. Create an API key
3. Set it in `GROQ_API_KEY`

## Usage

```bash
npm start
```

Then send messages to your WhatsApp group:

- **Text message** → a new agent spawns and responds
- **Reply to an agent's message** → the same agent continues the conversation
- **Voice message** → gets transcribed, then an agent processes it

## Project Structure

```
peleg-orchestra/
├── orchestra.ts           # Main orchestrator (polling, routing, spawning)
├── system-prompt.md       # System prompt template injected into each agent
├── .env.example           # Environment variable template
├── package.json
├── agents/
│   └── registry.json      # Agent state (session IDs, message IDs, status)
├── tools/
│   └── registry.json      # Shared tools built by agents
└── logs/                  # Per-agent output logs
```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `GREEN_API_URL` | Green API base URL | Yes |
| `GREEN_API_MEDIA_URL` | Green API media URL | Yes |
| `GREEN_API_INSTANCE` | Green API instance ID | Yes |
| `GREEN_API_TOKEN` | Green API token | Yes |
| `WA_GROUP_ID` | WhatsApp group ID (`...@g.us`) | Yes |
| `ALLOWED_SENDERS` | Comma-separated WhatsApp IDs to whitelist | **Strongly recommended** |
| `GROQ_API_KEY` | Groq API key (whisper-large-v3) | No (voice only) |
| `POLL_INTERVAL` | Polling interval in ms (default: 3000) | No |
| `MAX_AGENT_TURNS` | Max agent turns per run (default: 25) | No |

## 🚨 Security Warning

> **This system spawns Claude Code agents with `bypassPermissions` — full, unrestricted access to your machine. Any message that reaches the orchestrator WILL execute as a fully autonomous agent that can read, write, delete, and run anything.**

### Attack surface

This is not a theoretical risk. Understand what you're exposing:

| Vector | Risk | Mitigation |
|--------|------|------------|
| **Unauthorized group member** | Anyone in the WhatsApp group can command agents | Set `ALLOWED_SENDERS` whitelist |
| **Compromised WhatsApp API credentials** | If your Green API / WAHA token leaks, an attacker can send messages as any sender, **bypassing the whitelist entirely** | Guard `.env` like a root password. Never commit it. Rotate tokens regularly |
| **Compromised WhatsApp account** | If your phone is compromised, attacker has full access | Use 2FA on WhatsApp, secure your phone |
| **WAHA/Green API server compromise** | If the API provider is breached, messages can be injected | Self-host WAHA on trusted infrastructure if possible |
| **Agent escape** | An agent could modify the orchestrator itself, disable security, or exfiltrate data | Run on an isolated machine / VM with limited network access |
| **Prompt injection** | A crafted message could trick the agent into harmful actions | Agents inherit Claude's safety, but `bypassPermissions` removes guardrails |

### Sender Whitelist (minimum required)

Set `ALLOWED_SENDERS` in your `.env` to restrict who can command agents:

```env
ALLOWED_SENDERS=972501234567@c.us,972509876543@c.us
```

Only messages from these WhatsApp IDs will be processed. All others are blocked and logged.

**Important:** The whitelist checks the sender ID reported by the WhatsApp API. If an attacker has your API credentials (Green API token or WAHA endpoint), they can forge the sender ID and bypass the whitelist. The whitelist protects against unauthorized group members, NOT against API credential theft.

### Recommendations

- **Never run on a machine with sensitive data** — treat the host as potentially compromised
- **Use a dedicated VM or container** — isolate the orchestrator from your main environment
- **Guard your `.env` like root credentials** — anyone with the Green API token owns your machine
- **Keep the group to one member (yourself)** — minimize attack surface
- **Monitor the console** — blocked and authorized messages are all logged
- **Rotate API tokens regularly** — especially if you suspect a leak
- **Consider network isolation** — restrict what agents can reach (no SSH keys, no cloud credentials on the host)

### What happens if an unauthorized message is received?

The orchestra blocks it, logs the sender's name and ID to console, and sends a rejection message to the group: `🚫 Unauthorized sender`.

## Disclaimer

This software is provided "as is", without warranty of any kind. Use at your own risk. The authors are not responsible for any consequences of using this software, including but not limited to API costs, unintended actions by agents, or WhatsApp account restrictions.

Agents run with `bypassPermissions` mode, meaning they have full system access. Only run this on machines where you are comfortable granting that level of access.

## License

MIT
