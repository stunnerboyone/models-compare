/**
 * MacPaw AI gateway (Setapp) — the set of models actually reachable
 * through the gateway. Read-only, no auth.
 *
 * https://api.macpaw.com/ai/api/v1/model/info
 *
 * The catalogue mixes chat, embedding, image, audio and video models.
 * We only care about chat — nothing else has an Arena counterpart.
 *
 * Keys come prefixed with a provider path segment:
 *   "openrouter/x-ai/grok-4.3"
 *   "vertex_ai/gemini-3.1-pro-preview"
 * We return the last "/"-delimited segment, since that is the shape
 * Arena and the snapshot use.
 */

const URL = "https://api.macpaw.com/ai/api/v1/model/info";

export async function fetchGatewayChatModels() {
  const res = await fetch(URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`gateway: HTTP ${res.status}`);

  const json = await res.json();
  if (!Array.isArray(json?.data)) {
    throw new Error("gateway: unexpected payload — `data` is not an array");
  }

  const keys = new Set();
  for (const entry of json.data) {
    const info = entry?.model_info;
    if (!info || info.mode !== "chat") continue;
    if (typeof info.key !== "string" || info.key.length === 0) continue;
    const tail = info.key.split("/").pop();
    if (tail) keys.add(tail);
  }
  return keys;
}
