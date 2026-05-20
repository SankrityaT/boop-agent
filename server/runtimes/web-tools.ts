import { z } from "zod";
import { defineRuntimeTool } from "./tool.js";
import { runtimeText, type RuntimeTool } from "./types.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const DEFAULT_MAX_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string | null;
  results?: TavilySearchResult[];
}

interface TavilyExtractResult {
  url: string;
  raw_content?: string | null;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: Array<{ url: string; error: string }>;
}

function getTavilyKey(): string | undefined {
  const raw = process.env.TAVILY_API_KEY;
  return raw && raw.trim() ? raw.trim() : undefined;
}

export function isTavilyConfigured(): boolean {
  return getTavilyKey() !== undefined;
}

async function tavilyFetch<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = getTavilyKey();
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, ...body }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily ${url} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function formatSearchResponse(payload: TavilySearchResponse): string {
  const lines: string[] = [];
  if (payload.answer) {
    lines.push(`Summary: ${payload.answer}`);
    lines.push("");
  }
  const results = payload.results ?? [];
  if (results.length === 0) {
    lines.push("No results returned.");
    return lines.join("\n");
  }
  lines.push("Results:");
  for (const r of results) {
    lines.push(`- ${r.title}`);
    lines.push(`  ${r.url}`);
    if (r.content) {
      const snippet = r.content.replace(/\s+/g, " ").trim();
      lines.push(`  ${snippet.length > 280 ? snippet.slice(0, 280) + "…" : snippet}`);
    }
  }
  lines.push("");
  lines.push("Sources:");
  for (const r of results) {
    lines.push(`- ${r.url}`);
  }
  return lines.join("\n");
}

function formatExtractResponse(payload: TavilyExtractResponse): string {
  const lines: string[] = [];
  const ok = payload.results ?? [];
  const failed = payload.failed_results ?? [];
  if (ok.length === 0 && failed.length === 0) {
    return "No content extracted.";
  }
  for (const r of ok) {
    lines.push(`Fetched ${r.url}:`);
    const content = (r.raw_content ?? "").replace(/\s+/g, " ").trim();
    lines.push(content.length > 4000 ? content.slice(0, 4000) + "…" : content || "(empty)");
    lines.push("");
  }
  for (const f of failed) {
    lines.push(`Failed ${f.url}: ${f.error}`);
  }
  return lines.join("\n").trim();
}

// Tools registered under namespace "boop-web". Names match Codex's native
// web_search / web_fetch so prompts can reference both runtimes uniformly.
export function createWebTools(): RuntimeTool[] {
  if (!isTavilyConfigured()) return [];
  return [
    defineRuntimeTool(
      "boop-web",
      "web_search",
      "Search the open web for current information. Returns 3-5 result snippets with titles, URLs, and a short summary. Use this whenever the user needs live data: news, prices, hours, addresses, reviews, recent events, anything the model can't know from training.",
      {
        query: z.string().min(1).describe("Search query. Be specific."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many results to return. Default 5."),
      },
      async (args) => {
        try {
          const payload = await tavilyFetch<TavilySearchResponse>(TAVILY_SEARCH_URL, {
            query: args.query,
            search_depth: "basic",
            include_answer: true,
            max_results: args.max_results ?? DEFAULT_MAX_RESULTS,
          });
          return runtimeText(formatSearchResponse(payload));
        } catch (err) {
          return runtimeText(`web_search failed: ${String(err)}`, false);
        }
      },
    ),
    defineRuntimeTool(
      "boop-web",
      "web_fetch",
      "Fetch the readable content of a known URL. Use after web_search when you need the full body of a specific page. Pass one URL per call.",
      {
        url: z.string().url().describe("Fully-qualified URL to fetch."),
      },
      async (args) => {
        try {
          const payload = await tavilyFetch<TavilyExtractResponse>(TAVILY_EXTRACT_URL, {
            urls: [args.url],
            extract_depth: "basic",
          });
          return runtimeText(formatExtractResponse(payload));
        } catch (err) {
          return runtimeText(`web_fetch failed: ${String(err)}`, false);
        }
      },
    ),
  ];
}
