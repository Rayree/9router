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
    ]);
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

  it("is accepted and stored under the node id that chat dispatch reads", async () => {
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
    const put = await PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ headers }) }), { params });
    expect(put.status).toBe(200);

    const settings = await getSettings();
    expect(settings.providerOverrides[COMPAT_ID]).toEqual({ headers: CODEX_CLIENT_PRESET.headers });

    const got = await (await GET(new Request("http://localhost/x"), { params })).json();
    expect(got.headers).toEqual(CODEX_CLIENT_PRESET.headers);
    expect(got.builtinHeaders).toEqual({});
  });
});
