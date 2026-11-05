import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import codexRegistry from "open-sse/providers/registry/codex.js";
import {
  CODEX_CLIENT_PRESET,
  getHeaderPresets,
  applyHeaderPreset,
} from "@/app/(dashboard)/dashboard/providers/[id]/headerPresets.js";

const COMPAT_ID = "openai-compatible-chat-11111111-2222-3333-4444-555555555555";
const originalDataDir = process.env.DATA_DIR;
const INSTALLATION_HEADER = "x-codex-installation-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const { upstreamFetch } = vi.hoisted(() => ({ upstreamFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: upstreamFetch }));

describe("header presets", () => {
  it("offers the Codex preset only for OpenAI-compatible nodes", () => {
    expect(getHeaderPresets(COMPAT_ID)).toEqual([CODEX_CLIENT_PRESET]);
    expect(getHeaderPresets("openrouter")).toEqual([]);
    expect(getHeaderPresets("anthropic-compatible-abc")).toEqual([]);
  });

  it("takes originator and User-Agent from the codex registry", () => {
    const h = codexRegistry.transport.headers;
    expect(CODEX_CLIENT_PRESET.headers).toEqual({ originator: h.originator, "User-Agent": h["User-Agent"] });
    expect(CODEX_CLIENT_PRESET.headers["User-Agent"]).toMatch(/^codex_cli_rs\//);
  });

  it("replaces same-name rows case-insensitively, drops blanks, keeps the rest", () => {
    const rows = [
      { name: "", value: "" },
      { name: "user-agent", value: "curl/8" },
      { name: "X-Keep", value: "1" },
    ];
    expect(applyHeaderPreset(rows, CODEX_CLIENT_PRESET)).toEqual([
      { name: "X-Keep", value: "1" },
      { name: "originator", value: CODEX_CLIENT_PRESET.headers.originator },
      { name: "User-Agent", value: CODEX_CLIENT_PRESET.headers["User-Agent"] },
      { name: INSTALLATION_HEADER, value: expect.stringMatching(UUID_RE) },
    ]);
  });

  it("creates an independent installation id for each new node and keeps it on reapply", () => {
    const first = applyHeaderPreset([], CODEX_CLIENT_PRESET);
    const second = applyHeaderPreset([], CODEX_CLIENT_PRESET);
    const id = (rows) => rows.find((r) => r.name === INSTALLATION_HEADER)?.value;
    expect(id(first)).toMatch(UUID_RE);
    expect(id(second)).toMatch(UUID_RE);
    expect(id(first)).not.toBe(id(second));
    expect(applyHeaderPreset(first, CODEX_CLIENT_PRESET)).toEqual(first);
  });

  it("reuses a saved installation id case-insensitively and removes duplicate or empty rows", () => {
    const savedId = "97d6ee67-fd28-4e29-af4f-35fdb15d5b61";
    const rows = [
      { name: INSTALLATION_HEADER, value: " " },
      { name: " X-Codex-Installation-Id ", value: savedId },
      { name: INSTALLATION_HEADER, value: "duplicate" },
    ];
    expect(applyHeaderPreset(rows, CODEX_CLIENT_PRESET).filter((r) => r.name.toLowerCase() === INSTALLATION_HEADER))
      .toEqual([{ name: INSTALLATION_HEADER, value: savedId }]);
  });

  it("generates an installation id when the saved value is blank", () => {
    const rows = applyHeaderPreset([{ name: INSTALLATION_HEADER, value: " " }], CODEX_CLIENT_PRESET);
    expect(rows.find((r) => r.name === INSTALLATION_HEADER)?.value).toMatch(UUID_RE);
  });
});

describe("Codex preset through the overrides route", () => {
  let tempDir;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("next/server");
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("stores the preset and sends the installation identity through the real executor", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-header-presets-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } });
        },
      },
    }));

    const { PUT, GET } = await import("@/app/api/providers/[id]/overrides/route.js");
    const { getSettings } = await import("@/lib/db/index.js");
    const params = Promise.resolve({ id: COMPAT_ID });

    const rows = applyHeaderPreset([{ name: "", value: "" }], CODEX_CLIENT_PRESET);
    const headers = Object.fromEntries(rows.map((r) => [r.name, r.value]));
    expect(headers[INSTALLATION_HEADER]).toMatch(UUID_RE);
    const put = await PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ headers }) }), { params });
    expect(put.status).toBe(200);

    const settings = await getSettings();
    expect(settings.providerOverrides[COMPAT_ID]).toEqual({ headers });

    const got = await (await GET(new Request("http://localhost/x"), { params })).json();
    expect(got.headers).toEqual(headers);
    expect(got.builtinHeaders).toEqual({});

    // Exercise dispatch, including auth and the final custom-header merge.
    // Reproduce a relay that rejects the old two-header preset.
    upstreamFetch.mockImplementation(async (_url, options) => {
      const sent = new Headers(options.headers);
      const allowed = sent.get("originator") === codexRegistry.transport.headers.originator
        && sent.get("user-agent") === codexRegistry.transport.headers["User-Agent"]
        && UUID_RE.test(sent.get(INSTALLATION_HEADER) || "");
      return Response.json(allowed ? { ok: true } : { error: "This account only allows Codex official clients" }, {
        status: allowed ? 200 : 403,
      });
    });
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor(COMPAT_ID);
    const args = {
      model: "test-model", body: { messages: [{ role: "user", content: "OK" }], stream: false }, stream: false,
      credentials: { apiKey: "test-key", providerSpecificData: { baseUrl: "https://relay.example/v1" } },
    };
    const oldResult = await executor.execute({ ...args, providerOverrides: { headers: CODEX_CLIENT_PRESET.headers } });
    expect(oldResult.response.status).toBe(403);
    const result = await executor.execute({ ...args, providerOverrides: settings.providerOverrides[COMPAT_ID] });
    expect(result.response.status).toBe(200);
    expect(new Headers(result.headers).get("authorization")).toBe("Bearer test-key");
  });
});
