#!/usr/bin/env npx ts-node

import { execSync, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

// ── Config ──────────────────────────────────────────────────────────────────

const ENV_PATH = path.join(__dirname, ".env");
const REGISTRY_PATH = path.join(__dirname, "agents", "registry.json");
const TOOLS_REGISTRY = path.join(__dirname, "tools", "registry.json");
const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.md");
const LOGS_DIR = path.join(__dirname, "logs");
const TMP_DIR = path.join(__dirname, "tmp");

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const GREEN_URL = process.env.GREEN_API_URL!;
const GREEN_INSTANCE = process.env.GREEN_API_INSTANCE!;
const GREEN_TOKEN = process.env.GREEN_API_TOKEN!;
const GREEN_MEDIA_URL = process.env.GREEN_API_MEDIA_URL!;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY!;
const WA_GROUP_ID = process.env.WA_GROUP_ID!;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "3000", 10);
const MAX_TURNS = parseInt(process.env.MAX_AGENT_TURNS || "25", 10);

// ── Types ───────────────────────────────────────────────────────────────────

interface AgentRecord {
  sessionId: string;
  status: "running" | "idle" | "done";
  waMessageIds: string[];
  parentAgentId: string | null;
  prompt: string;
  pid: number | null;
  createdAt: string;
}

interface AgentRegistry {
  [agentId: string]: AgentRecord;
}

interface WAMessage {
  idMessage: string;
  typeMessage: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  textMessage?: string;
  timestamp: number;
  extendedTextMessageData?: {
    text: string;
    stanzaId: string;
    participant?: string;
  };
  downloadUrl?: string;
  fileName?: string;
  mimeType?: string;
}

// ── Nanoid (inline, no ESM issues) ──────────────────────────────────────────

function shortId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 7; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Agent Registry ──────────────────────────────────────────────────────────

function loadRegistry(): AgentRegistry {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveRegistry(reg: AgentRegistry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function createAgent(prompt: string, parentId: string | null = null): string {
  const reg = loadRegistry();
  const id = `agent-claude-wa-${shortId()}`;
  reg[id] = {
    sessionId: uuid(),
    status: "idle",
    waMessageIds: [],
    parentAgentId: parentId,
    prompt,
    pid: null,
    createdAt: new Date().toISOString(),
  };
  saveRegistry(reg);
  return id;
}

function getAgent(agentId: string): AgentRecord | null {
  return loadRegistry()[agentId] || null;
}

function updateAgent(agentId: string, updates: Partial<AgentRecord>) {
  const reg = loadRegistry();
  if (!reg[agentId]) return;
  Object.assign(reg[agentId], updates);
  saveRegistry(reg);
}

function addWaMessageId(agentId: string, messageId: string) {
  const reg = loadRegistry();
  if (!reg[agentId]) return;
  reg[agentId].waMessageIds.push(messageId);
  saveRegistry(reg);
}

function findAgentByWaMessageId(messageId: string): string | null {
  const reg = loadRegistry();
  for (const [agentId, agent] of Object.entries(reg)) {
    if (agent.waMessageIds.includes(messageId)) return agentId;
  }
  return null;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function greenApiUrl(method: string): string {
  return `${GREEN_URL}/waInstance${GREEN_INSTANCE}/${method}/${GREEN_TOKEN}`;
}

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: data })
        );
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const file = fs.createWriteStream(dest);
    mod
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location!;
          downloadFile(redirectUrl, dest).then(resolve).catch(reject);
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

// ── WhatsApp Module ─────────────────────────────────────────────────────────

async function pollMessages(): Promise<WAMessage[]> {
  const url = greenApiUrl("lastIncomingMessages") + "?minutes=1";
  const res = await httpRequest(url);
  if (res.status !== 200) {
    console.error(`Poll error: ${res.status} ${res.body}`);
    return [];
  }
  try {
    return JSON.parse(res.body);
  } catch {
    console.error("Failed to parse poll response:", res.body.slice(0, 200));
    return [];
  }
}

async function sendMessage(
  text: string,
  quotedMessageId?: string
): Promise<string | null> {
  const payload: Record<string, string> = {
    chatId: WA_GROUP_ID,
    message: text,
  };
  if (quotedMessageId) {
    payload.quotedMessageId = quotedMessageId;
  }
  const body = JSON.stringify(payload);
  const res = await httpRequest(greenApiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  try {
    const data = JSON.parse(res.body);
    return data.idMessage || null;
  } catch {
    console.error("Send error:", res.body.slice(0, 200));
    return null;
  }
}

async function downloadMedia(downloadUrl: string): Promise<string> {
  const ext = ".ogg";
  const filePath = path.join(TMP_DIR, `voice_${Date.now()}${ext}`);
  await downloadFile(downloadUrl, filePath);
  return filePath;
}

// ── Voice Transcription (ElevenLabs Scribe) ─────────────────────────────────

async function transcribeAudio(filePath: string): Promise<string> {
  console.log(`  🎙️ Transcribing: ${path.basename(filePath)}`);

  const fileBuffer = fs.readFileSync(filePath);
  const boundary = `----FormBoundary${Date.now()}`;
  const fileName = path.basename(filePath);

  const parts: Buffer[] = [];

  // file field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/ogg\r\n\r\n`
    )
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from("\r\n"));

  // model_id field
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n`
    )
  );

  // language_code (auto-detect)
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="tag_audio_events"\r\n\r\nfalse\r\n`
    )
  );

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.elevenlabs.io",
        path: "/v1/speech-to-text",
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_KEY,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 120000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const text = parsed.text || parsed.transcript || "";
            console.log(
              `  ✅ Transcribed: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`
            );
            // Clean up temp file
            try {
              fs.unlinkSync(filePath);
            } catch {}
            resolve(text);
          } catch {
            console.error("Transcription parse error:", data.slice(0, 200));
            reject(new Error("Failed to parse transcription response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Transcription request timed out"));
    });
    req.write(body);
    req.end();
  });
}

// ── Agent Spawner ───────────────────────────────────────────────────────────

function getSystemPrompt(agentId: string): string {
  let template = "";
  try {
    template = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  } catch {
    template = "You are a Claude Code agent in the orchestra system.";
  }
  return template.replace(/\{AGENT_ID\}/g, agentId);
}

async function spawnAgent(
  agentId: string,
  prompt: string,
  replyToMessageId?: string
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) return;

  updateAgent(agentId, { status: "running" });
  const systemPrompt = getSystemPrompt(agentId);
  const logFile = path.join(LOGS_DIR, `${agentId}.log`);

  console.log(`  🚀 Spawning agent: ${agentId}`);
  console.log(`     Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  try {
    const args = [
      "-p",
      "--session-id",
      agent.sessionId,
      "--output-format",
      "json",
      "--max-turns",
      String(MAX_TURNS),
      "--permission-mode",
      "bypassPermissions",
      "--append-system-prompt",
      systemPrompt,
      prompt,
    ];

    const result = execSync(`claude ${args.map(a => shellEscape(a)).join(" ")}`, {
      encoding: "utf-8",
      timeout: 300000, // 5 min
      maxBuffer: 10 * 1024 * 1024,
      cwd: __dirname,
    });

    // Parse output
    let output = "";
    try {
      const parsed = JSON.parse(result);
      output = parsed.result || parsed.content || result;
      // If result is an array of content blocks
      if (Array.isArray(parsed.result)) {
        output = parsed.result
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
    } catch {
      output = result.trim();
    }

    // Log output
    fs.appendFileSync(
      logFile,
      `\n--- ${new Date().toISOString()} ---\nPrompt: ${prompt}\nOutput: ${output}\n`
    );

    // Truncate if too long for WhatsApp
    if (output.length > 3500) {
      output = output.slice(0, 3500) + "\n\n... (truncated)";
    }

    // Send to WhatsApp
    const waMessage = `🤖 *${agentId}*\n\n${output}`;
    const sentId = await sendMessage(waMessage, replyToMessageId);

    if (sentId) {
      addWaMessageId(agentId, sentId);
    }

    updateAgent(agentId, { status: "idle" });
    console.log(`  ✅ Agent ${agentId} completed`);
  } catch (err: any) {
    const errorMsg = err.stderr || err.message || "Unknown error";
    console.error(`  ❌ Agent ${agentId} error:`, errorMsg.slice(0, 200));

    // Still try to report error to WhatsApp
    const waMessage = `🤖 *${agentId}*\n\n❌ Error: ${errorMsg.slice(0, 500)}`;
    const sentId = await sendMessage(waMessage, replyToMessageId);
    if (sentId) addWaMessageId(agentId, sentId);

    updateAgent(agentId, { status: "idle" });
    fs.appendFileSync(
      logFile,
      `\n--- ${new Date().toISOString()} ERROR ---\n${errorMsg}\n`
    );
  }
}

async function resumeAgent(
  agentId: string,
  replyText: string,
  replyToMessageId?: string
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) return;

  updateAgent(agentId, { status: "running" });
  const logFile = path.join(LOGS_DIR, `${agentId}.log`);

  console.log(`  🔄 Resuming agent: ${agentId}`);
  console.log(`     Reply: "${replyText.slice(0, 80)}${replyText.length > 80 ? "..." : ""}"`);

  try {
    const args = [
      "-p",
      "--resume",
      agent.sessionId,
      "--output-format",
      "json",
      "--max-turns",
      String(MAX_TURNS),
      "--permission-mode",
      "bypassPermissions",
      replyText,
    ];

    const result = execSync(`claude ${args.map(a => shellEscape(a)).join(" ")}`, {
      encoding: "utf-8",
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: __dirname,
    });

    let output = "";
    try {
      const parsed = JSON.parse(result);
      output = parsed.result || parsed.content || result;
      if (Array.isArray(parsed.result)) {
        output = parsed.result
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }
    } catch {
      output = result.trim();
    }

    fs.appendFileSync(
      logFile,
      `\n--- ${new Date().toISOString()} RESUME ---\nReply: ${replyText}\nOutput: ${output}\n`
    );

    if (output.length > 3500) {
      output = output.slice(0, 3500) + "\n\n... (truncated)";
    }

    const waMessage = `🤖 *${agentId}*\n\n${output}`;
    const sentId = await sendMessage(waMessage, replyToMessageId);
    if (sentId) addWaMessageId(agentId, sentId);

    updateAgent(agentId, { status: "idle" });
    console.log(`  ✅ Agent ${agentId} resume completed`);
  } catch (err: any) {
    const errorMsg = err.stderr || err.message || "Unknown error";
    console.error(`  ❌ Agent ${agentId} resume error:`, errorMsg.slice(0, 200));

    const waMessage = `🤖 *${agentId}*\n\n❌ Error: ${errorMsg.slice(0, 500)}`;
    const sentId = await sendMessage(waMessage, replyToMessageId);
    if (sentId) addWaMessageId(agentId, sentId);

    updateAgent(agentId, { status: "idle" });
    fs.appendFileSync(
      logFile,
      `\n--- ${new Date().toISOString()} RESUME ERROR ---\n${errorMsg}\n`
    );
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Message Router ──────────────────────────────────────────────────────────

const processedMessages = new Set<string>();
let ownSenderId: string | null = null;

async function detectOwnId(): Promise<void> {
  try {
    const url = greenApiUrl("getSettings");
    const res = await httpRequest(url);
    const data = JSON.parse(res.body);
    ownSenderId = data.wid || null;
    if (ownSenderId) {
      console.log(`📱 Own WhatsApp ID: ${ownSenderId}`);
    }
  } catch (err) {
    console.warn("Could not detect own sender ID:", err);
  }
}

function isOwnMessage(msg: WAMessage): boolean {
  if (!ownSenderId) return false;
  // senderId format varies: "0503973736@c.us" or full number
  if (msg.senderId === ownSenderId) return true;
  // Also check if sender matches our number pattern
  return false;
}

async function routeMessage(msg: WAMessage): Promise<void> {
  // Skip if already processed
  if (processedMessages.has(msg.idMessage)) return;
  processedMessages.add(msg.idMessage);

  // Skip if not from our group
  if (msg.chatId !== WA_GROUP_ID) return;

  // Skip own messages
  if (isOwnMessage(msg)) return;

  // Skip messages from agents (starts with bot emoji)
  if (msg.textMessage?.startsWith("🤖")) return;

  const senderName = msg.senderName || "Unknown";
  console.log(
    `\n📨 Message from ${senderName}: type=${msg.typeMessage}`
  );

  // ── Reply to an agent message ──
  if (
    msg.typeMessage === "quotedMessage" &&
    msg.extendedTextMessageData?.stanzaId
  ) {
    const quotedId = msg.extendedTextMessageData.stanzaId;
    const agentId = findAgentByWaMessageId(quotedId);
    const replyText = msg.extendedTextMessageData.text || "";

    if (agentId && replyText) {
      console.log(`  → Routing reply to agent: ${agentId}`);
      await resumeAgent(agentId, replyText, msg.idMessage);
      return;
    }
    // If quote not from agent, treat as new message
    if (replyText) {
      console.log(`  → Quoted message not from agent, spawning new`);
      const newAgentId = createAgent(replyText);
      await spawnAgent(newAgentId, replyText, msg.idMessage);
      return;
    }
  }

  // ── Voice/audio message ──
  if (
    (msg.typeMessage === "audioMessage" ||
      msg.typeMessage === "voiceMessage") &&
    msg.downloadUrl
  ) {
    console.log(`  🎤 Voice message detected, downloading...`);
    try {
      const audioPath = await downloadMedia(msg.downloadUrl);
      const transcription = await transcribeAudio(audioPath);

      if (transcription.trim()) {
        // Acknowledge transcription
        await sendMessage(
          `🎙️ *Transcription:*\n${transcription.slice(0, 500)}`,
          msg.idMessage
        );

        // Spawn agent with transcription
        const agentId = createAgent(transcription);
        await spawnAgent(agentId, transcription, msg.idMessage);
      } else {
        await sendMessage("⚠️ Could not transcribe voice message", msg.idMessage);
      }
    } catch (err: any) {
      console.error("Voice handling error:", err.message);
      await sendMessage("⚠️ Voice transcription failed", msg.idMessage);
    }
    return;
  }

  // ── Regular text message → spawn new agent ──
  const text = msg.textMessage || msg.extendedTextMessageData?.text || "";
  if (!text.trim()) return;

  // Skip if it's a system/status message
  if (text.startsWith("🤖") || text.startsWith("🎙️") || text.startsWith("⚠️")) return;

  console.log(`  → New command, spawning agent`);
  const agentId = createAgent(text);
  await spawnAgent(agentId, text, msg.idMessage);
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   🎼 Peleg Orchestra - Command Center       ║");
  console.log("║   WhatsApp Agent Commander                   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  // Validate config
  if (!GREEN_URL || !GREEN_INSTANCE || !GREEN_TOKEN) {
    console.error("❌ Missing Green API credentials in .env");
    process.exit(1);
  }
  if (!WA_GROUP_ID) {
    console.error("❌ WA_GROUP_ID not set in .env");
    console.error("   Create the WhatsApp group first, then set the ID");
    process.exit(1);
  }
  if (!ELEVENLABS_KEY) {
    console.warn("⚠️ ELEVENLABS_API_KEY not set - voice messages will be skipped");
  }

  // Detect own ID to filter self-messages
  await detectOwnId();

  // Verify Claude CLI is available
  try {
    execSync("claude --version", { encoding: "utf-8" });
    console.log("✅ Claude CLI found");
  } catch {
    console.error("❌ Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  console.log(`📡 Polling group ${WA_GROUP_ID} every ${POLL_INTERVAL / 1000}s`);
  console.log("🎧 Listening for commands...\n");

  // Main polling loop
  let consecutiveErrors = 0;
  while (true) {
    try {
      const messages = await pollMessages();
      consecutiveErrors = 0;

      // Process messages oldest-first
      const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);

      for (const msg of sorted) {
        try {
          await routeMessage(msg);
        } catch (err: any) {
          console.error(`Error routing message ${msg.idMessage}:`, err.message);
        }
      }

      // Prune old processed IDs (keep last 500)
      if (processedMessages.size > 500) {
        const arr = Array.from(processedMessages);
        const toRemove = arr.slice(0, arr.length - 500);
        toRemove.forEach((id) => processedMessages.delete(id));
      }
    } catch (err: any) {
      consecutiveErrors++;
      console.error(`Poll error (${consecutiveErrors}):`, err.message);
      if (consecutiveErrors > 10) {
        console.error("Too many consecutive errors, waiting 30s...");
        await sleep(30000);
        consecutiveErrors = 0;
      }
    }

    await sleep(POLL_INTERVAL);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Start ───────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
