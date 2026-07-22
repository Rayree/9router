// Codex client identity-headers facade — shared by CodexExecutor (official codex
// provider) and DefaultExecutor (when an OpenAI-compatible Custom Provider opts
// into codex emulation via providerSpecificData.simulateCodex).
//
// These tests pin the exact header set and the guard/priority semantics so a
// third-party gateway that only accepts codex-shaped clients gets the same
// identity headers the official codex CLI would send.
import { describe, it, expect } from "vitest";
import {
  applyCodexFacadeHeaders,
  CODEX_CLIENT_ORIGINATOR,
  CODEX_CLIENT_USER_AGENT,
} from "../../open-sse/shared/codexFacade.js";

const baseHeaders = () => ({ "Content-Type": "application/json" });

describe("applyCodexFacadeHeaders — header set", () => {
  it("injects the full codex identity header set", () => {
    const headers = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { connectionId: "conn-123" },
    });
    expect(headers["originator"]).toBe(CODEX_CLIENT_ORIGINATOR);
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["User-Agent"]).toBe(CODEX_CLIENT_USER_AGENT);
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.136.0");
    expect(headers["session_id"]).toBe("conn-123");
    // No account id present → ChatGPT-Account-ID must NOT be added.
    expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
  });

  it("falls back session_id to connectionId when no explicit sessionId passed", () => {
    const headers = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { connectionId: "fallback-conn" },
    });
    expect(headers["session_id"]).toBe("fallback-conn");
  });

  it('falls back session_id to "default" when connectionId absent too', () => {
    const headers = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: {},
    });
    expect(headers["session_id"]).toBe("default");
  });

  it("prefers an explicitly passed sessionId over connectionId", () => {
    const headers = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { connectionId: "conn-123" },
      sessionId: "stable-session-456",
    });
    expect(headers["session_id"]).toBe("stable-session-456");
  });
});

describe("applyCodexFacadeHeaders — guard semantics", () => {
  it("does not overwrite an existing originator / User-Agent / session_id", () => {
    // Downstream client or registry transport may already set these; the facade
    // must defer (matches CodexExecutor's `if (!headers[k])` prior behavior).
    const headers = applyCodexFacadeHeaders(
      {
        "Content-Type": "application/json",
        originator: "custom_originator",
        "User-Agent": "my-app/1.0",
        session_id: "client-supplied-session",
      },
      { credentials: { connectionId: "conn-123" }, sessionId: "should-not-win" },
    );
    expect(headers["originator"]).toBe("custom_originator");
    expect(headers["User-Agent"]).toBe("my-app/1.0");
    expect(headers["session_id"]).toBe("client-supplied-session");
  });

  it("does not add User-Agent when injectUserAgent is false", () => {
    // CodexExecutor relies on the registry's transport.headers for UA in that path;
    // passing injectUserAgent:false lets it reuse only session/account logic.
    const headers = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { connectionId: "conn-123" },
      injectUserAgent: false,
    });
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["session_id"]).toBe("conn-123");
    expect(headers["User-Agent"]).toBeUndefined();
  });
});

describe("applyCodexFacadeHeaders — ChatGPT-Account-ID priority", () => {
  it("prefers workspaceId, then chatgptAccountId, then accountId", () => {
    const withWorkspace = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { providerSpecificData: { workspaceId: "ws-1", chatgptAccountId: "acc-1", accountId: "acc-2" } },
    });
    expect(withWorkspace["ChatGPT-Account-ID"]).toBe("ws-1");

    const withChatgpt = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { providerSpecificData: { chatgptAccountId: "acc-1", accountId: "acc-2" } },
    });
    expect(withChatgpt["ChatGPT-Account-ID"]).toBe("acc-1");

    const withAccount = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { providerSpecificData: { accountId: "acc-2" } },
    });
    expect(withAccount["ChatGPT-Account-ID"]).toBe("acc-2");
  });

  it("does not set ChatGPT-Account-ID when no account id is available", () => {
    const headers = applyCodexFacadeHeaders(baseHeaders(), {
      credentials: { providerSpecificData: {} },
    });
    expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
  });

  it("does not overwrite an existing ChatGPT-Account-ID", () => {
    const headers = applyCodexFacadeHeaders(
      { "Content-Type": "application/json", "ChatGPT-Account-ID": "preset" },
      { credentials: { providerSpecificData: { workspaceId: "ws-1" } } },
    );
    expect(headers["ChatGPT-Account-ID"]).toBe("preset");
  });
});

describe("applyCodexFacadeHeaders — edge cases", () => {
  it("is a no-op safe call on a non-object headers input", () => {
    expect(applyCodexFacadeHeaders(null, { credentials: {} })).toBeNull();
    expect(applyCodexFacadeHeaders(undefined, { credentials: {} })).toBeUndefined();
  });

  it("works with no credentials at all (sessionId default chain)", () => {
    const headers = applyCodexFacadeHeaders(baseHeaders(), {});
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.136.0");
    expect(headers["session_id"]).toBe("default");
  });

  it("mutates and returns the same headers object reference", () => {
    const headers = baseHeaders();
    const returned = applyCodexFacadeHeaders(headers, { credentials: { connectionId: "c1" } });
    expect(returned).toBe(headers);
    expect(headers["session_id"]).toBe("c1");
  });
});
