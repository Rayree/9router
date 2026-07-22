import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext(nodeData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-provider-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/providers/route.js");
  const {
    createProviderNode,
    getProviderConnections,
  } = await import("@/models/index.js");

  const node = await createProviderNode(nodeData);

  return {
    node,
    POST,
    getProviderConnections,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function makeRequest(provider, name = "Test Connection") {
  return new Request("https://9router.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      apiKey: "test-key",
      name,
      defaultModel: "test-model",
    }),
  });
}

function expectCompatibleConnection(connection, node, { apiType } = {}) {
  expect(connection.provider).toBe(node.id);
  expect(connection.authType).toBe("apikey");
  expect(connection.defaultModel).toBe("test-model");
  expect(connection.providerSpecificData).toMatchObject({
    prefix: node.prefix,
    baseUrl: node.baseUrl,
    nodeName: node.name,
  });

  if (apiType !== undefined) {
    expect(connection.providerSpecificData.apiType).toBe(apiType);
  }
}

describe("compatible provider connections API", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates one API-key connection for an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-test",
      type: "openai-compatible",
      name: "OpenAI Compatible Test Node",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://openai-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node, { apiType: "chat" });
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        apiType: "chat",
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("creates one API-key connection for an Anthropic-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-test",
      type: "anthropic-compatible",
      name: "Anthropic Compatible Test Node",
      prefix: "act",
      baseUrl: "https://anthropic-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node);
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("allows multiple connections on the same compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-multiple-test",
      type: "openai-compatible",
      name: "Multiple Connections Node",
      prefix: "mul",
      apiType: "chat",
      baseUrl: "https://multiple-connections.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, "Key A"));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, "Key B"));
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(storedConnections).toHaveLength(2);
    expectCompatibleConnection(storedConnections[0], ctx.node, { apiType: "chat" });
    expectCompatibleConnection(storedConnections[1], ctx.node, { apiType: "chat" });
  });

  // createProviderNode must persist `simulateCodex` (codex client emulation flag).
  // Regression guard: it was previously dropped because createProviderNode hand-lists
  // fields instead of spreading `data`, so the UI toggle silently had no effect.
  it("persists simulateCodex=true when creating an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-codex-emulation-on",
      type: "openai-compatible",
      name: "Codex Emulation On Node",
      prefix: "ceo",
      apiType: "responses",
      baseUrl: "https://codex-restricted.test/v1",
      simulateCodex: true,
    });
    cleanup = ctx.cleanup;

    expect(ctx.node.simulateCodex).toBe(true);
    // Re-read from DB to confirm round-trip persistence (not just the return value).
    const { getProviderNodeById } = await import("@/models/index.js");
    const reread = await getProviderNodeById(ctx.node.id);
    expect(reread.simulateCodex).toBe(true);
  });

  it("defaults simulateCodex to false when not provided", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-codex-emulation-default",
      type: "openai-compatible",
      name: "Codex Emulation Default Node",
      prefix: "ced",
      apiType: "chat",
      baseUrl: "https://plain-openai.test/v1",
    });
    cleanup = ctx.cleanup;

    expect(ctx.node.simulateCodex).toBe(false);
  });

  it("persists simulateCodex=false when explicitly false", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-codex-emulation-off",
      type: "openai-compatible",
      name: "Codex Emulation Off Node",
      prefix: "cof",
      apiType: "chat",
      baseUrl: "https://plain-openai.test/v1",
      simulateCodex: false,
    });
    cleanup = ctx.cleanup;

    expect(ctx.node.simulateCodex).toBe(false);
    const { getProviderNodeById } = await import("@/models/index.js");
    const reread = await getProviderNodeById(ctx.node.id);
    expect(reread.simulateCodex).toBe(false);
  });

  // End-to-end: a node with simulateCodex=true must propagate the flag onto its
  // connection's providerSpecificData (the value DefaultExecutor.buildHeaders reads).
  it("propagates simulateCodex onto the connection's providerSpecificData", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-codex-emulation-propagation",
      type: "openai-compatible",
      name: "Codex Emulation Propagation Node",
      prefix: "cpr",
      apiType: "responses",
      baseUrl: "https://codex-restricted.test/v1",
      simulateCodex: true,
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    expect(response.status).toBe(201);
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0].providerSpecificData.simulateCodex).toBe(true);
  });
});
