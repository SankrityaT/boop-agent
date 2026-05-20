import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type { RuntimeRunRequest, RuntimeRunResult, RuntimeTool } from "./types.js";
import { EMPTY_USAGE, estimateGroqCostUsd, type UsageTotals } from "../usage.js";
import { formatError } from "../error-format.js";

const GROQ_BASE_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const DEFAULT_MAX_TURNS = 16;

// Groq's vision-capable Llama 4 models accept image_url content parts the same
// way OpenAI's vision models do. For text-only models we drop image blocks
// with a logged warning so the agent loop never silently mangles a request.
const VISION_CAPABLE_MODEL_PATTERNS = [
  /^llama-?4/i,
  /maverick/i,
  /scout/i,
  /llama-3\.2-.*-vision/i,
];

function modelSupportsVision(model: string): boolean {
  return VISION_CAPABLE_MODEL_PATTERNS.some((re) => re.test(model));
}

function runtimeToolId(runtimeTool: RuntimeTool): string {
  return `mcp__${runtimeTool.namespace}__${runtimeTool.name}`;
}

// Groq/OpenAI tool function names have to match `^[a-zA-Z0-9_-]+$`. We expose
// tools to the model by their short name (e.g. "spawn_agent") because the
// system prompt references them that way, and Llama 4 mirrors prompt language
// when calling tools. All tool names in this codebase are unique across
// namespaces, so collisions are not a concern. We keep `runtimeToolId` (the
// full `mcp__namespace__name` form) for allowed/disallowed pattern matching,
// which still uses the namespaced ids.
function functionNameForTool(runtimeTool: RuntimeTool): string {
  return runtimeTool.name;
}

function matchesToolPattern(toolId: string, pattern: string): boolean {
  return pattern.endsWith("__*")
    ? toolId.startsWith(pattern.slice(0, -"__*".length))
    : toolId === pattern;
}

function isRuntimeToolAllowed(
  request: RuntimeRunRequest,
  runtimeTool: RuntimeTool,
): boolean {
  const toolId = runtimeToolId(runtimeTool);
  if (request.disallowedTools?.some((pattern) => matchesToolPattern(toolId, pattern))) {
    return false;
  }
  if (request.allowedTools) {
    return request.allowedTools.some((pattern) => matchesToolPattern(toolId, pattern));
  }
  return true;
}

function buildUserMessage(
  prompt: RuntimeRunRequest["prompt"],
  model: string,
): ChatCompletionMessageParam {
  if (typeof prompt === "string") {
    return { role: "user", content: prompt };
  }
  const supportsVision = modelSupportsVision(model);
  const parts: ChatCompletionContentPart[] = [];
  let droppedImages = 0;
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (!supportsVision) {
        droppedImages++;
        continue;
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    }
  }
  if (droppedImages > 0) {
    console.warn(
      `[groq] dropped ${droppedImages} image block(s) — model "${model}" is not vision-capable. Switch to llama-4-maverick or llama-4-scout for image support.`,
    );
  }
  // OpenAI rejects content arrays with zero parts, so fall back to an empty
  // string user turn if every block got dropped.
  if (parts.length === 0) {
    return { role: "user", content: "" };
  }
  return { role: "user", content: parts };
}

function toOpenAITools(tools: RuntimeTool[]): ChatCompletionTool[] {
  return tools.map((runtimeTool) => ({
    type: "function" as const,
    function: {
      name: functionNameForTool(runtimeTool),
      description: runtimeTool.description,
      parameters: runtimeTool.jsonSchema,
    },
  }));
}

function parseToolArguments(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Llama sometimes emits arguments wrapped in extra quoting / trailing
    // junk. We surface the raw blob under a conventional key so the tool's
    // own validator can at least produce a useful error.
    return { _rawArguments: trimmed };
  }
}

interface StreamedToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

interface StreamedTurn {
  text: string;
  toolCalls: StreamedToolCall[];
  finishReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
}

async function runStreamedTurn(
  client: OpenAI,
  params: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools: ChatCompletionTool[] | undefined;
    abortSignal: AbortSignal | undefined;
    onText: ((text: string) => void | Promise<void>) | undefined;
  },
): Promise<StreamedTurn> {
  const stream = await client.chat.completions.create(
    {
      model: params.model,
      messages: params.messages,
      ...(params.tools && params.tools.length > 0
        ? { tools: params.tools, tool_choice: "auto" as const }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    params.abortSignal ? { signal: params.abortSignal } : undefined,
  );

  let text = "";
  let finishReason: string | null = null;
  let usage: StreamedTurn["usage"] = null;
  const toolCallsByIndex = new Map<number, StreamedToolCall>();

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;

    const delta = choice?.delta;
    if (delta?.content) {
      text += delta.content;
      await params.onText?.(delta.content);
    }

    if (delta?.tool_calls) {
      for (const piece of delta.tool_calls) {
        const idx = piece.index ?? 0;
        const existing = toolCallsByIndex.get(idx) ?? {
          id: "",
          name: "",
          argumentsText: "",
        };
        if (piece.id) existing.id = piece.id;
        if (piece.function?.name) existing.name = piece.function.name;
        if (piece.function?.arguments) existing.argumentsText += piece.function.arguments;
        toolCallsByIndex.set(idx, existing);
      }
    }

    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.id && call.name);

  return { text, toolCalls, finishReason, usage };
}

export async function runGroqAgent(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local (get one at https://console.groq.com/keys).",
    );
  }

  const client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
  const availableTools = request.tools.filter((runtimeTool) =>
    isRuntimeToolAllowed(request, runtimeTool),
  );
  const toolsById = new Map(
    availableTools.map((runtimeTool) => [functionNameForTool(runtimeTool), runtimeTool]),
  );
  const openaiTools = toOpenAITools(availableTools);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: request.systemPrompt },
    buildUserMessage(request.prompt, request.model),
  ];

  const usage: UsageTotals = { ...EMPTY_USAGE, model: request.model };
  let fullText = "";
  let lastAssistantText = "";

  const abortSignal = request.abortController?.signal;

  for (let turn = 0; turn < DEFAULT_MAX_TURNS; turn++) {
    if (abortSignal?.aborted) throw new Error("Groq runtime aborted");

    let result: StreamedTurn;
    try {
      result = await runStreamedTurn(client, {
        model: request.model,
        messages,
        tools: openaiTools,
        abortSignal,
        onText: request.onText,
      });
    } catch (err) {
      throw new Error(
        `Groq request failed (model=${request.model}, mode=${request.mode}, turn=${turn + 1}): ${formatError(err)}`,
        { cause: err },
      );
    }

    if (result.usage) {
      // Groq returns per-turn usage. Accumulate across the agent loop so the
      // caller's UsageTotals reflects the entire conversation, not just the
      // final turn (matches how aggregateUsageFromResult works for Claude).
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.costUsd = estimateGroqCostUsd(usage);
      await request.onUsage?.(usage);
    }

    if (result.text) {
      fullText += result.text;
      // Only treat this turn's text as the user-facing reply when the model
      // is NOT also calling tools. Text that accompanies tool_calls is the
      // model "thinking out loud" (e.g. "calling save_draft now" or a JSON
      // payload echo) — promoting it to lastAssistantText is what causes the
      // tool-call narration leak into iMessage. The real reply lives in the
      // final no-tool-call turn after tool_results return.
      if (result.text.trim() && result.toolCalls.length === 0) {
        lastAssistantText = result.text;
      }
    }

    const assistantMessage: ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: result.text || null,
      ...(result.toolCalls.length > 0
        ? {
            tool_calls: result.toolCalls.map<ChatCompletionMessageToolCall>((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.argumentsText || "{}" },
            })),
          }
        : {}),
    };
    messages.push(assistantMessage);

    if (result.toolCalls.length === 0) {
      // No tool calls → assistant is done. Most finish reasons land here
      // ("stop", "length", null mid-stream then resolved). For "length" we
      // still return what we have; the caller logs and surfaces a fallback.
      break;
    }

    for (const call of result.toolCalls) {
      if (abortSignal?.aborted) throw new Error("Groq runtime aborted");
      const runtimeTool = toolsById.get(call.name);
      const args = parseToolArguments(call.argumentsText);
      await request.onToolUse?.(call.name, args);

      let toolText: string;
      if (!runtimeTool) {
        toolText = `Unknown tool "${call.name}". This tool is not registered with the Groq runtime — pick one of the available tools listed in this turn's tools array.`;
      } else {
        try {
          const handled = await runtimeTool.handle(args);
          toolText = handled.text;
        } catch (err) {
          toolText = `Tool ${call.name} threw: ${formatError(err)}`;
        }
      }
      await request.onToolResult?.(call.name, toolText);

      const toolMessage: ChatCompletionToolMessageParam = {
        role: "tool",
        tool_call_id: call.id,
        content: toolText,
      };
      messages.push(toolMessage);
    }
  }

  return { text: lastAssistantText || fullText, usage };
}
