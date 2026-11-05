// One-click header presets for the Custom Headers card (fork addition).
//
// Some third-party OpenAI-compatible relays only serve requests that look like the
// official Codex CLI. Upstream's Custom Headers card can carry that identity, so a
// preset just fills the rows instead of making the user type them. Values come from
// the codex registry transport so a code-side CLI version bump flows through.
import codexRegistry from "open-sse/providers/registry/codex.js";
import { isOpenAICompatibleProvider } from "@/shared/constants/providers";
import { v4 as uuidv4 } from "uuid";

const CODEX_HEADERS = codexRegistry.transport.headers;

// Some relays also require an x-codex-* engine identity (verified against zzz,
// 2026-11-04). Generate an independent installation id per saved node; do not
// reuse the machine id, account id, or another client's installation identity.
export const CODEX_CLIENT_PRESET = {
  id: "codex-client",
  label: "Codex 客户端",
  description: "填入 Codex 客户端请求头及安装标识并保存，重复点击保留已有安装标识",
  headers: {
    originator: CODEX_HEADERS.originator,
    "User-Agent": CODEX_HEADERS["User-Agent"],
  },
  generatedHeaders: {
    "x-codex-installation-id": uuidv4,
  },
};

export function getHeaderPresets(providerId) {
  return isOpenAICompatibleProvider(providerId) ? [CODEX_CLIENT_PRESET] : [];
}

// Merge a preset into the card's rows: drop blank rows and any row whose name matches
// a preset header case-insensitively (avoids sending both "user-agent" and
// "User-Agent"), then append the preset headers. Other rows are kept as-is.
export function applyHeaderPreset(rows, preset) {
  const headers = { ...preset.headers };
  for (const [name, generate] of Object.entries(preset.generatedHeaders || {})) {
    const existing = rows.find((r) => r.name.trim().toLowerCase() === name.toLowerCase() && r.value.trim());
    headers[name] = existing?.value.trim() || generate();
  }
  const presetNames = new Set(Object.keys(headers).map((n) => n.toLowerCase()));
  const kept = rows.filter((r) => r.name.trim() && !presetNames.has(r.name.trim().toLowerCase()));
  return [...kept, ...Object.entries(headers).map(([name, value]) => ({ name, value }))];
}
