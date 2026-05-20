import type { RuntimeName } from "./types.js";
import { isTavilyConfigured } from "./web-tools.js";

// Single source of truth for what each runtime can actually do. The interaction
// agent's prompt, the execution agent's prompt, and the allowedTools list all
// derive from here so they can't drift apart.
//
// - Claude: WebSearch / WebFetch are built into the Claude Agent SDK and only
//   need to appear in `allowedTools` (PascalCase) to be enabled.
// - Codex: the app-server has a native `web_search` (lowercase) capability we
//   turn on per-mode in codex-app-server.ts:codexConfigForMode (live for
//   execution, disabled for dispatcher). Supports search + open_page +
//   find_in_page (covers both webSearch and webFetch semantics).
// - Groq: no built-in web. We expose `web_search` and `web_fetch` as
//   RuntimeTools backed by Tavily (see web-tools.ts). Capability is on only
//   when TAVILY_API_KEY is set so missing-key cases degrade gracefully.
export interface RuntimeCapabilities {
  webSearch: boolean;
  webFetch: boolean;
}

export function capabilitiesFor(runtime: RuntimeName): RuntimeCapabilities {
  switch (runtime) {
    case "claude":
      return { webSearch: true, webFetch: true };
    case "codex":
      return { webSearch: true, webFetch: true };
    case "groq": {
      const hasTavily = isTavilyConfigured();
      return { webSearch: hasTavily, webFetch: hasTavily };
    }
  }
}

export function hasWebAccess(caps: RuntimeCapabilities): boolean {
  return caps.webSearch || caps.webFetch;
}

// Comma-separated tool-name list for the execution-agent system prompt so
// the model on each runtime knows the exact names of the web tools it can
// call. Names match what the model will actually see in its tools list:
// - claude: Claude SDK built-ins (PascalCase).
// - codex: codex app-server's native web_search (covers search + open_page).
// - groq: our Tavily RuntimeTools, registered under snake_case names.
export function describeWebTools(
  runtime: RuntimeName,
  caps: RuntimeCapabilities,
): string {
  if (!caps.webSearch && !caps.webFetch) return "";
  switch (runtime) {
    case "claude": {
      const parts: string[] = [];
      if (caps.webSearch) parts.push("WebSearch");
      if (caps.webFetch) parts.push("WebFetch");
      return parts.join(", ");
    }
    case "codex":
      // Codex's web_search action subsumes search + open_page + find_in_page.
      return "web_search";
    case "groq": {
      const parts: string[] = [];
      if (caps.webSearch) parts.push("web_search");
      if (caps.webFetch) parts.push("web_fetch");
      return parts.join(", ");
    }
  }
}

// Built-in tool names a runtime can resolve natively. Only the Claude SDK
// uses string tokens in allowedTools to enable its built-ins ("WebSearch",
// "WebFetch"). Codex enables web tools via the thread/start config flag —
// nothing to allowlist. Groq uses our Tavily RuntimeTools, allowlisted
// separately via the "boop-web" namespace.
export function nativeWebToolNames(
  runtime: RuntimeName,
  caps: RuntimeCapabilities,
): string[] {
  if (runtime !== "claude") return [];
  const names: string[] = [];
  if (caps.webSearch) names.push("WebSearch");
  if (caps.webFetch) names.push("WebFetch");
  return names;
}
