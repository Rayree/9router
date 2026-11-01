// One-click header presets for the Custom Headers card (fork addition).
//
// Some third-party OpenAI-compatible relays only serve requests that look like the
// official Codex CLI. Upstream's Custom Headers card can carry that identity, so a
// preset just fills the rows instead of making the user type them. Values come from
// the codex registry transport so a code-side CLI version bump flows through.
import codexRegistry from "open-sse/providers/registry/codex.js";
import { isOpenAICompatibleProvider } from "@/shared/constants/providers";

const CODEX_HEADERS = codexRegistry.transport.headers;

// Only the identity headers verified against client-restricted relays (2026-11-01,
// free.hiyo.top). `session_id` is not settable here: the override API rejects
// header names with underscores.
export const CODEX_CLIENT_PRESET = {
  id: "codex-client",
  label: "Codex 客户端",
  description: "填入 Codex CLI 的 originator 和 User-Agent 并保存，用于只放行 Codex 客户端的中转站",
  headers: {
    originator: CODEX_HEADERS.originator,
    "User-Agent": CODEX_HEADERS["User-Agent"],
  },
};

export function getHeaderPresets(providerId) {
  return isOpenAICompatibleProvider(providerId) ? [CODEX_CLIENT_PRESET] : [];
}

// Merge a preset into the card's rows: drop blank rows and any row whose name matches
// a preset header case-insensitively (avoids sending both "user-agent" and
// "User-Agent"), then append the preset headers. Other rows are kept as-is.
export function applyHeaderPreset(rows, preset) {
  const presetNames = new Set(Object.keys(preset.headers).map((n) => n.toLowerCase()));
  const kept = rows.filter((r) => r.name.trim() && !presetNames.has(r.name.trim().toLowerCase()));
  return [...kept, ...Object.entries(preset.headers).map(([name, value]) => ({ name, value }))];
}
