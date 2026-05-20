import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import {
  buildMcpServersForIntegrations,
  buildRuntimeToolsForIntegrations,
  listIntegrations,
} from "./integrations/registry.js";
import { createDraftStagingTools } from "./draft-tools.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import type { RuntimeName } from "./runtimes/types.js";
import {
  capabilitiesFor,
  describeWebTools,
  hasWebAccess,
  nativeWebToolNames,
  type RuntimeCapabilities,
} from "./runtimes/capabilities.js";
import { createWebTools } from "./runtimes/web-tools.js";
import { buildPromptWithImages, fetchStoredBytes } from "./images/content-blocks.js";

const running = new Map<string, AbortController>();

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Composio surfaces the targeted account in a few different shapes depending on
// the tool. Pull whichever one is present so multi-account runs (e.g. 3 Gmail
// inboxes) make the chosen account visible per call.
function extractAccounts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const accounts = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim()) accounts.add(v.trim());
  };
  const obj = input as Record<string, unknown>;
  // Direct fields on the top-level call (single-execute, native Composio tools).
  collect(obj.account);
  collect(obj.connectedAccountId);
  collect(obj.connected_account_id);
  if (Array.isArray(obj.accounts)) obj.accounts.forEach(collect);
  // COMPOSIO_MULTI_EXECUTE_TOOL fans out: { tools: [{ account, ... }] }.
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (t && typeof t === "object") {
        const tt = t as Record<string, unknown>;
        collect(tt.account);
        collect(tt.connectedAccountId);
        collect(tt.connected_account_id);
      }
    }
  }
  return [...accounts];
}

function buildExecutionSystem(
  runtime: RuntimeName,
  caps: RuntimeCapabilities,
): string {
  const webTools = describeWebTools(runtime, caps);
  const toolsLine = hasWebAccess(caps)
    ? `2. Use your tools — ${webTools}, and any integrations loaded for this spawn — to investigate and act.`
    : `2. Use your tools — the integrations loaded for this spawn — to investigate and act. You do NOT have web search or URL fetching on the current runtime.`;

  const researchBlock = hasWebAccess(caps)
    ? `Research discipline:
- Use ${webTools} for any fresh/factual question or when you need the body of a specific URL.
- Cite real URLs only — NEVER invent sources. If a page failed to load, say so.
- Cross-check when it matters: one search is rarely enough for a claim.

MANDATORY: for any task that used a web tool, end your response with a
"Sources:" section listing the ACTUAL URLs you fetched or found. Example:

  Sources:
  - https://www.lonelyplanet.com/japan/tokyo
  - https://www.japan-guide.com/e/e3008.html

No URLs = no sources section. Never write vague names like "Lonely Planet" or
"official guide" without the specific URL. The interaction agent relays your
output to the user verbatim, so if you don't include URLs, the user won't see
any.`
    : `No web access on this runtime:
- You CANNOT search the web, fetch URLs, or look up live information (hours, prices, news, addresses, reviews, current events, etc.).
- If the task requires live/web data, do NOT guess or recite from training data. Reply with ONE short sentence: "can't pull live web info on the current runtime. paste a link/screenshot or run \\\`switch to claude\\\` to enable web research."
- If the task is satisfiable from the integrations loaded for this spawn (gmail, calendar, etc.), proceed with those normally.
- Never invent URLs or sources. No "Sources:" section unless an integration actually returned URLs.`;

  return `You are a focused background worker for the user.

Your job:
1. Perform the task you were given, end to end.
${toolsLine}
3. Return a concise, well-structured answer — not a data dump.

${researchBlock}

Style:
- Optimize for iMessage delivery: short sentences, bullets over paragraphs, no tables.
- Prefer markdown with **bold** keywords and • bullets.
- Under 500 words unless explicitly asked for more.
- If you can't complete something, say why in one sentence.

Tool calls are silent (absolute rule):
Your text output is forwarded verbatim — either to the user via iMessage (for one-shot reminders / scheduled automations) or to the dispatcher which relays it. The tool calls themselves are out-of-band. Your text must NEVER include:
- "Calling tool X" / "I'm now calling Y" / "I called save_draft" / "Saving via..."
- "Calling tool to save draft (required by developer safety instructions)" — no such instruction exists. Do not write this sentence.
- JSON payloads of tool arguments. Never echo \`save_draft({...})\` or any \`{...}\` blob as text. JSON belongs in tool inputs, not in your prose output.
- Internal labels like \`[reminder: ...]\`, \`[<automation_name>]\`, or "save_draft payload (JSON)" sections.
- Meta-narration about your reasoning, tool selection, or "what I would send if I were sending."

If you stage a draft via save_draft, your prose output is a brief human summary of WHAT was drafted (one sentence), never the JSON. The dispatcher / draft system handles confirmation UX — you do not need to show the payload.

Safety:
- Anything that sends a message, creates an event, or takes an external action: call save_draft with a JSON payload instead of the real send/create tool. Return the summary so the interaction agent can show it to the user.
- Only the interaction agent's send_draft tool commits. You never commit.`;
}

export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  runtimeConfig?: RuntimeConfig;
  imageStorageIds?: string[];
  // When true, do not load save_draft / send_draft / reject_draft tools for
  // this spawn. Used by one-shot reminder automations where the execution
  // agent should reply directly with the reminder text (which the automation
  // runner then dispatches as iMessage), not stage a draft Sanki has to
  // confirm. Without this flag, gpt-5-mini reliably wraps even trivial
  // reminders in the draft flow because save_draft is in its tool surface.
  skipDrafts?: boolean;
}

export type SpawnExecutionAgentOpts = SpawnOptions;

export interface SpawnResult {
  agentId: string;
  result: string;
  status: "completed" | "failed" | "cancelled";
}

export async function spawnExecutionAgent(opts: SpawnExecutionAgentOpts): Promise<SpawnResult> {
  const agentId = randomId("agent");
  const name = opts.name ?? (opts.integrations.join("+") || "general");
  const abort = new AbortController();
  running.set(agentId, abort);

  const shortId = agentId.slice(-6);
  const logAgent = (msg: string) => console.log(`[agent ${shortId}] ${msg}`);
  const taskPreview =
    opts.task.length > 120 ? opts.task.slice(0, 120) + "…" : opts.task;
  logAgent(
    `spawn: ${name} [${opts.integrations.join(", ") || "no integrations"}] images=${opts.imageStorageIds?.length ?? 0} — ${JSON.stringify(taskPreview)}`,
  );
  const agentStart = Date.now();
  const runtimeConfig = opts.runtimeConfig ?? (await getRuntimeConfig());

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name,
    task: opts.task,
    runtime: runtimeConfig.runtime,
    model: runtimeConfig.model,
    reasoningEffort: runtimeConfig.reasoningEffort,
    billingMode: runtimeConfig.billingMode,
    mcpServers: opts.integrations,
  });
  broadcast("agent_spawned", { agentId, name, task: opts.task });

  await convex.mutation(api.agents.update, { agentId, status: "running" });

  const draftTools = opts.conversationId && !opts.skipDrafts ? createDraftStagingTools(opts.conversationId) : [];
  const integrationServers =
    runtimeConfig.runtime === "claude"
      ? await buildMcpServersForIntegrations(opts.integrations, opts.conversationId)
      : {};
  const integrationTools =
    runtimeConfig.runtime === "codex" || runtimeConfig.runtime === "groq"
      ? await buildRuntimeToolsForIntegrations(opts.integrations, opts.conversationId)
      : [];
  const mcpServers = integrationServers;
  const capabilities = capabilitiesFor(runtimeConfig.runtime);
  // Tavily-backed web_search / web_fetch — only attached on runtimes that
  // don't have native web tooling (i.e. groq). Claude uses SDK built-ins
  // and codex uses its app-server's web_search. createWebTools() returns
  // [] when TAVILY_API_KEY is missing, which is also when capabilitiesFor
  // reports webSearch=false for groq, so the two paths stay in sync.
  const webTools =
    runtimeConfig.runtime === "groq" && hasWebAccess(capabilities)
      ? createWebTools()
      : [];
  const runtimeTools = [...draftTools, ...integrationTools, ...webTools];
  const runtimeToolNamespaces = [...new Set(integrationTools.map((tool) => tool.namespace))];
  const allowedTools = [
    ...nativeWebToolNames(runtimeConfig.runtime, capabilities),
    "Skill",
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
    ...(draftTools.length ? ["mcp__boop-drafts__*"] : []),
    ...(webTools.length ? ["mcp__boop-web__*"] : []),
    ...runtimeToolNamespaces.flatMap((n) => [`mcp__${n}__*`]),
  ];

  let buffer = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMsg: string | undefined;

  try {
    const executionPrompt = await buildPromptWithImages({
      text: opts.task,
      imageStorageIds: opts.imageStorageIds,
      fetchBytes: fetchStoredBytes,
    });
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: executionPrompt,
      systemPrompt: buildExecutionSystem(runtimeConfig.runtime, capabilities),
      claudeMcpServers: mcpServers,
      tools: runtimeTools,
      allowedTools,
      abortController: abort,
      mode: "execution",
      onText: async (text) => {
        buffer += text;
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "text",
          content: text,
        });
      },
      onToolUse: async (toolName, input) => {
        const toolShort = toolName.replace(/^mcp__[a-z-]+__/, "");
        const accounts = extractAccounts(input);
        const acctSuffix = accounts.length ? ` [${accounts.join(", ")}]` : "";
        logAgent(`tool: ${toolShort}${acctSuffix}`);
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_use",
          toolName,
          ...(accounts.length ? { accounts } : {}),
          content: JSON.stringify(input).slice(0, 2000),
        });
        broadcast("agent_tool", { agentId, toolName, accounts });
      },
      onToolResult: async (_toolName, text) => {
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_result",
          content: text.slice(0, 2000),
        });
      },
    });
    // Prefer the adapter's reconciled `result.text` (which excludes text from
    // tool-calling turns) over the raw streaming buffer. The buffer captures
    // every onText chunk for debug logging; using it as the user-facing
    // result is what surfaces tool-call narration ("calling save_draft…",
    // JSON echoes) as iMessage content.
    buffer = result.text || buffer;
    usage = result.usage;
  } catch (err) {
    status = abort.signal.aborted ? "cancelled" : "failed";
    errorMsg = String(err);
    console.error(`[execution-agent ${agentId}] failed:`, err);
    await convex.mutation(api.agents.addLog, {
      agentId,
      logType: "error",
      content: errorMsg,
    });
  } finally {
    running.delete(agentId);
  }

  const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
  logAgent(
    `done (${status}, ${elapsed}s, in/out tokens ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)})`,
  );

  await convex.mutation(api.agents.update, {
    agentId,
    status,
    result: buffer,
    error: errorMsg,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
  });
  // Also append to the usage log so total-cost queries cover every layer.
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "execution",
      conversationId: opts.conversationId,
      agentId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - agentStart,
    });
  }
  broadcast("agent_done", { agentId, status, result: buffer.slice(0, 200) });

  return { agentId, result: buffer || errorMsg || "(no output)", status };
}

export function cancelAgent(agentId: string): boolean {
  const abort = running.get(agentId);
  if (!abort) return false;
  abort.abort();
  return true;
}

export function runningAgentIds(): string[] {
  return [...running.keys()];
}

export async function retryAgent(agentId: string): Promise<SpawnResult | null> {
  const existing = await convex.query(api.agents.get, { agentId });
  if (!existing) return null;
  const originalRuntime = existing as typeof existing & Partial<RuntimeConfig>;
  const runtimeConfig =
    originalRuntime.runtime && originalRuntime.model && originalRuntime.billingMode
      ? {
          runtime: originalRuntime.runtime,
          model: originalRuntime.model,
          reasoningEffort: originalRuntime.reasoningEffort,
          billingMode: originalRuntime.billingMode,
        }
      : undefined;
  // V1 limitation: image refs are not persisted to executionAgents and
  // therefore are not replayed on retry. Re-trigger from the original
  // turn if you need the image inputs.
  return await spawnExecutionAgent({
    task: existing.task,
    integrations: existing.mcpServers,
    conversationId: existing.conversationId,
    name: existing.name,
    runtimeConfig,
  });
}

export function availableIntegrations(): string[] {
  return listIntegrations().map((i) => i.name);
}
