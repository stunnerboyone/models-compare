/**
 * OpenRouter model catalogue — used ONLY for context window and as a
 * cross-check on pricing.
 *
 * IMPORTANT: OpenRouter prices are the provider price plus OpenRouter's own
 * service fee. They are NOT the vendor's official list price. Do not publish
 * them as "Anthropic pricing" / "OpenAI pricing" without a label.
 *
 * Enabled with WITH_OPENROUTER=1. Off by default.
 *
 * Docs: https://openrouter.ai/docs/guides/overview/models
 */

const URL = "https://openrouter.ai/api/v1/models";

/** pricing fields come back as USD per single token, as strings */
function perMillion(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

export async function fetchOpenRouter() {
  const res = await fetch(URL, { headers: { accept: "application/json" } });

  if (!res.ok) {
    throw new Error(`openrouter: HTTP ${res.status}`);
  }

  const json = await res.json();

  if (!Array.isArray(json.data)) {
    throw new Error("openrouter: unexpected payload — `data` is not an array");
  }

  const out = {};
  for (const m of json.data) {
    if (!m?.id) continue;
    out[m.id] = {
      id: m.id,
      name: m.name ?? null,
      // Unix seconds. The only real release date available anywhere in our
      // sources — Arena publishes scores but no dates at all.
      created: Number.isFinite(m.created) ? m.created : null,
      context_length: m.context_length ?? null,
      price_input_per_mtok: perMillion(m.pricing?.prompt),
      price_output_per_mtok: perMillion(m.pricing?.completion),
    };
  }

  return out;
}
