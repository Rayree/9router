// Codex client identity-headers facade.
//
// Shared logic for making an upstream request look like it originates from the
// official Codex CLI (`codex_cli_rs`). Used by:
//   - `CodexExecutor.buildHeaders` (the official codex provider)
//   - `DefaultExecutor.buildHeaders` when an OpenAI-compatible Custom Provider
//     has `simulateCodex === true` set on its connection's `providerSpecificData`
//     (to reach third-party gateways that only accept codex-shaped clients).
//
// Token handling is deliberately out of scope here: this only injects identity
// headers. ``Authorization`` is set by the caller (BaseExecutor's auth path).

// Matches `open-sse/providers/registry/codex.js` transport.headers["User-Agent"].
// Keep these two in sync — single version string for the codex client family.
export const CODEX_CLIENT_ORIGINATOR = "codex_cli_rs";
export const CODEX_CLIENT_USER_AGENT = "codex_cli_rs/0.136.0";

// Inject codex identity headers onto an existing `headers` object (mutates).
//
// Every header is guarded by `if (!headers[k])` so an explicit value already
// present (e.g. sourced from the downstream client or registry transport) wins.
//
// Inputs:
//   headers           - the headers map being built (mutated in place)
//   credentials       - executor credentials; reads connectionId + providerSpecificData
//   sessionId         - optional pre-resolved session id (CodexExecutor passes
//                       this._currentSessionId); falls back to connectionId, then "default".
//   injectUserAgent   - when false, skips User-Agent (lets the official codex
//                       provider rely on its registry transport.headers for UA
//                       while still reusing session/account logic). Default true.
export function applyCodexFacadeHeaders(headers, { credentials, sessionId = null, injectUserAgent = true } = {}) {
  if (!headers || typeof headers !== "object") return headers;

  if (!headers["session_id"]) {
    headers["session_id"] = sessionId || credentials?.connectionId || "default";
  }
  if (!headers["originator"]) {
    headers["originator"] = CODEX_CLIENT_ORIGINATOR;
  }
  if (injectUserAgent && !headers["User-Agent"]) {
    headers["User-Agent"] = CODEX_CLIENT_USER_AGENT;
  }

  const accountId = (
    credentials?.providerSpecificData?.workspaceId
    || credentials?.providerSpecificData?.chatgptAccountId
    || credentials?.providerSpecificData?.accountId
  );
  if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
    headers["ChatGPT-Account-ID"] = accountId;
  }

  return headers;
}