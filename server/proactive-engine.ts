// Proactive engine. Runs on an interval and decides, on its own, whether to
// interrupt Sanki with a short iMessage. Default OFF (settings.proactive_enabled
// = "true" to enable). Silence-biased: the model is instructed to return
// NO_PING unless the signal is high enough to justify an interrupt.
//
// v1 signals:
// - Pending drafts older than 12h (the agent staged something Sanki forgot to
//   send/reject).
//
// Add new signals by extending gatherSignals() + formatSignals() — the LLM
// prompt is shape-agnostic, it just sees a labeled list and decides.

import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { sendImessage } from "./sendblue.js";
import { broadcast } from "./broadcast.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getUserTimezone } from "./timezone-config.js";

const TICK_INTERVAL_MS = 30 * 60_000; // 30 min between ticks
const COOLDOWN_MS = 60 * 60_000;       // 60 min between actual sends
const STALE_DRAFT_MS = 12 * 3_600_000; // a draft is "stale" after 12h
const DEFAULT_QUIET_START_HOUR = 22;   // 10pm local
const DEFAULT_QUIET_END_HOUR = 7;      // 7am local
const MAX_MESSAGE_LEN = 240;

const PROACTIVE_SYSTEM = `You are Mango's PROACTIVE ENGINE. Your only job is to decide whether to interrupt Sanki RIGHT NOW with exactly one short iMessage.

You are AGGRESSIVELY SILENCE-BIASED. The default is to say nothing. Only interrupt if the signal is high enough that a thoughtful friend would also bring it up unprompted. The user trusts you not to spam.

Hard rules:
- Output is EXACTLY one of:
  - NO_PING  (literal token, no quotes, nothing else) — when nothing's worth interrupting for.
  - The iMessage text itself: max ${MAX_MESSAGE_LEN} chars, plain lowercase chill voice, no markdown, no preamble, no labels, no "Hey Sanki" greeting.
- NEVER use em-dashes (— or –). Use commas, periods, or parentheses instead.
- Pick AT MOST ONE thing to surface. If multiple signals compete, choose the single highest-signal one.
- Do NOT narrate your reasoning. Do NOT write "Reminder: X" or "I noticed Y". Just the chill text Sanki would actually want to read.
- Do NOT include tool calls, JSON, or any meta text. Tool calls happen elsewhere; you only produce text.

When to ping:
- A draft Sanki staged 12+ hours ago that he hasn't sent or rejected — worth a one-line nudge if it's been sitting.

When to stay silent (NO_PING):
- Anything routine, vague, or "FYI-only."
- Anything Sanki almost certainly already knows.
- Multiple low-signal items where none individually crosses the bar.
- If you'd be the second or third ping in the same day about similar things.

Examples of good pings:
  "yo, that draft to sarah is still sitting from this morning — send or scrap?"
  "the q4 deck reply you drafted last night never went out, want to send?"

Examples of what NO_PING covers:
  - A draft staged 4 hours ago (too fresh).
  - "Reminder to drink water."
  - Anything Sanki didn't ask for and wouldn't appreciate.`;

interface StaleDraft {
  draftId: string;
  conversationId: string;
  kind: string;
  summary: string;
  ageHours: number;
}

interface ProactiveSignals {
  staleDrafts: StaleDraft[];
}

async function isProactiveEnabled(): Promise<boolean> {
  try {
    const v = await convex.query(api.settings.get, { key: "proactive_enabled" });
    return v === "true";
  } catch (err) {
    console.warn("[proactive-engine] failed to read enabled flag", err);
    return false;
  }
}

async function getUserPhone(): Promise<string | null> {
  const raw = process.env.BOOP_USER_PHONE?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function hourInTimezone(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  });
  // "23" or "00" formats — Number() handles both.
  return Number(fmt.format(date));
}

function isQuietHour(date: Date, tz: string): boolean {
  const h = hourInTimezone(date, tz);
  if (Number.isNaN(h)) return false;
  // Window wraps midnight: quiet if h >= start OR h < end.
  return h >= DEFAULT_QUIET_START_HOUR || h < DEFAULT_QUIET_END_HOUR;
}

async function gatherSignals(): Promise<ProactiveSignals> {
  const stale = await convex.query(api.drafts.pendingOlderThan, {
    thresholdMs: STALE_DRAFT_MS,
  });
  const now = Date.now();
  return {
    staleDrafts: stale.map((d) => ({
      draftId: d.draftId,
      conversationId: d.conversationId,
      kind: d.kind,
      summary: d.summary,
      ageHours: Math.floor((now - d.createdAt) / 3_600_000),
    })),
  };
}

function hasAnySignal(s: ProactiveSignals): boolean {
  return s.staleDrafts.length > 0;
}

function formatSignals(s: ProactiveSignals, recentPings: string[]): string {
  const lines: string[] = [];
  lines.push("CURRENT SIGNALS:");
  if (s.staleDrafts.length > 0) {
    lines.push("");
    lines.push(`Stale drafts (pending, older than 12h):`);
    for (const d of s.staleDrafts) {
      lines.push(`- [${d.kind}] ${d.summary} (${d.ageHours}h old, draftId=${d.draftId})`);
    }
  } else {
    lines.push("(no stale drafts)");
  }
  if (recentPings.length > 0) {
    lines.push("");
    lines.push("RECENT PROACTIVE PINGS YOU ALREADY SENT (do NOT repeat these):");
    for (const p of recentPings) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("Decide now: NO_PING or one short iMessage text.");
  return lines.join("\n");
}

interface DecisionResult {
  text: string;
  triggerKind: string;
  triggerRef?: string;
}

async function makeDecision(
  signals: ProactiveSignals,
  recentPings: string[],
): Promise<string> {
  const cfg = await getRuntimeConfig();
  const prompt = formatSignals(signals, recentPings);
  const result = await runAgentRuntime(cfg, {
    prompt,
    systemPrompt: PROACTIVE_SYSTEM,
    tools: [],
    mode: "background",
    allowedTools: [],
  });
  // Log the cost — the engine ticks frequently, so visibility matters.
  if (result.usage.costUsd > 0 || result.usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "proactive",
      runtime: cfg.runtime,
      billingMode: cfg.billingMode,
      model: result.usage.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      costUsd: result.usage.costUsd,
      durationMs: 0,
    });
  }
  return result.text.trim();
}

function inferTrigger(
  decision: string,
  signals: ProactiveSignals,
): { triggerKind: string; triggerRef?: string } {
  // If the model mentions a specific draftId, anchor the trigger to it so
  // dedup queries can match precisely. Otherwise fall back to a generic
  // "engine_tick" label.
  for (const d of signals.staleDrafts) {
    if (decision.toLowerCase().includes(d.draftId.toLowerCase())) {
      return { triggerKind: "stale_draft", triggerRef: d.draftId };
    }
  }
  if (signals.staleDrafts.length > 0) {
    // The decision didn't name an id but stale drafts are the only signal
    // surfaced, so the most likely subject is the freshest stale draft.
    return { triggerKind: "stale_draft", triggerRef: signals.staleDrafts[0].draftId };
  }
  return { triggerKind: "engine_tick" };
}

export async function tickProactiveEngine(): Promise<void> {
  if (!(await isProactiveEnabled())) return;

  const userPhone = await getUserPhone();
  if (!userPhone) {
    console.warn("[proactive-engine] BOOP_USER_PHONE not set, skipping tick");
    return;
  }

  const tz = await getUserTimezone();
  if (isQuietHour(new Date(), tz)) return;

  const lastSent = await convex.query(api.proactiveSends.lastSentAt, { userPhone });
  if (lastSent && Date.now() - lastSent < COOLDOWN_MS) return;

  const signals = await gatherSignals();
  if (!hasAnySignal(signals)) return;

  const recent = await convex.query(api.proactiveSends.recentSends, {
    userPhone,
    sinceMs: 24 * 3_600_000,
  });
  const recentTexts = recent.map((r) => r.messageContent);

  const decision = await makeDecision(signals, recentTexts);
  if (!decision || decision === "NO_PING" || decision.toUpperCase() === "NO_PING") {
    return;
  }

  // Clamp length defensively — the prompt asks for ${MAX_MESSAGE_LEN} max but
  // models occasionally over-shoot. Better a truncated nudge than a wall.
  const text =
    decision.length > MAX_MESSAGE_LEN
      ? decision.slice(0, MAX_MESSAGE_LEN - 1) + "…"
      : decision;

  const conversationId = `sms:${userPhone}`;
  const { triggerKind, triggerRef } = inferTrigger(text, signals);

  try {
    await sendImessage(userPhone, text);
  } catch (err) {
    console.error("[proactive-engine] sendImessage failed", err);
    return;
  }

  await convex.mutation(api.proactiveSends.record, {
    userPhone,
    conversationId,
    triggerKind,
    triggerRef,
    messageContent: text,
  });
  await convex.mutation(api.messages.send, {
    conversationId,
    role: "assistant",
    content: text,
  });
  broadcast("proactive_engine_send", { conversationId, content: text, triggerKind });
  console.log(`[proactive-engine] sent (${triggerKind}): ${text}`);
}

export function startProactiveEngineLoop(intervalMs = TICK_INTERVAL_MS): () => void {
  // Stagger the first tick so it doesn't race the rest of the boot loops.
  const initial = setTimeout(() => {
    tickProactiveEngine().catch((err) =>
      console.error("[proactive-engine] initial tick error", err),
    );
  }, 60_000);
  const timer = setInterval(() => {
    tickProactiveEngine().catch((err) =>
      console.error("[proactive-engine] tick error", err),
    );
  }, intervalMs);
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
