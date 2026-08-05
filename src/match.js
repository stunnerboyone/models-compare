/**
 * Matches Arena model names to OpenRouter ids.
 *
 * The two sources name the same model differently:
 *
 *   Arena        claude-opus-4-5-20251101-thinking-32k
 *   OpenRouter   anthropic/claude-opus-4.5
 *
 * Matching runs in two passes:
 *
 *   STRICT — normalisations that cannot change which model is meant:
 *            org prefix, :variant suffix, parentheticals, release dates,
 *            reasoning-mode and thinking-budget suffixes, dash-vs-dot in
 *            version numbers.
 *
 *   LOOSE  — normalisations that *could* merge two distinct models:
 *            -it, -preview, -beta, -v1.0, quantisation tags, a vendor name
 *            repeated inside the model name, and bare 4-digit date stamps.
 *            Only used for models strict didn't resolve, and only when the
 *            result is unambiguous on both sides.
 *
 * Why the split: Arena lists `mistral-large-2411` and `mistral-large-2402`,
 * OpenRouter lists `mistral-large` and `mistral-large-2512`. Stripping the
 * date collapses four distinct models into one key and attaches a price
 * essentially at random. The loose pass detects that collision and declines
 * to match rather than guessing.
 *
 * Every model records `price_match: "strict" | "loose" | null` so a loose
 * price can be spot-checked or suppressed downstream.
 */

// Reasoning modes — same underlying model, same price, separate Arena entry.
// Sorted longest-first so `no-thinking` wins over `thinking`.
const MODE_SUFFIXES = [
  "no-thinking",
  "nothinking",
  "nonthinking",
  "thinking",
  "reasoning",
  "minimal",
  "medium",
  "xhigh",
  "high",
  "low",
].sort((a, b) => b.length - a.length);

const QUANT_SUFFIXES = ["nvfp4", "bf16", "fp16", "fp8", "int8", "int4", "awq", "gguf"];

// Effort levels that only some vendors expose as separate leaderboard entries.
// These are LOOSE-only on purpose: `-max` is a reasoning tier for Anthropic
// (claude-opus-5-max) but a product tier for Alibaba (qwen3.8-max, a real model
// with its own price). Stripping it in the strict pass would break Qwen. In the
// loose pass it is only reached by names that already failed an exact match, so
// qwen3.8-max never gets there.
const LOOSE_MODE_SUFFIXES = ["max", "ultra", "pro-max"];

/** normalisations that cannot change which model is meant */
function strictBase(raw) {
  if (!raw) return { id: "", mode: null };

  let s = String(raw).toLowerCase().trim();

  // anthropic/claude-opus-5:free -> claude-opus-5
  s = s.slice(s.indexOf("/") + 1);
  const colon = s.indexOf(":");
  if (colon !== -1) s = s.slice(0, colon);

  // "gemini-3-flash (thinking-minimal)" -> gemini-3-flash-thinking-minimal
  s = s.replace(/\s*\(([^)]*)\)/g, "-$1");
  s = s.replace(/[\s_]+/g, "-").replace(/-+/g, "-");

  // Suffixes stack: -20251101-thinking-32k. Peel until nothing more comes off.
  let mode = null;
  for (let i = 0; i < 6; i++) {
    const before = s;

    // thinking budget: -32k, -16k
    s = s.replace(/-\d+k$/, "");

    // release dates in every shape upstream uses
    s = s
      .replace(/-\d{4}-\d{2}-\d{2}$/, "") // -2025-02-19
      .replace(/-\d{2}-\d{2}-\d{2}$/, "") // -26-02-10
      .replace(/-\d{8}$/, "") // -20250219
      .replace(/-\d{2}-\d{4}$/, "") // -09-2025
      .replace(/-\d{2}-\d{2}$/, ""); // -02-24

    for (const suffix of MODE_SUFFIXES) {
      if (s.endsWith(`-${suffix}`)) {
        mode ??= suffix;
        s = s.slice(0, -(suffix.length + 1));
        break;
      }
    }

    if (s === before) break;
  }

  // version separators: opus-4-5 -> opus-4.5. Applied to both sources, so
  // even where it reads oddly (gemma-2-9b -> gemma-2.9b) it stays consistent.
  s = s.replace(/(\d)-(?=\d)/g, "$1.");
  s = s.replace(/-latest$/, "");

  return { id: s, mode };
}

/** further normalisations that might merge distinct models */
function looseCore(raw) {
  let s = strictBase(raw).id;

  for (let i = 0; i < 6; i++) {
    const before = s;

    for (const suffix of LOOSE_MODE_SUFFIXES) {
      if (s.endsWith(`-${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1));
        break;
      }
    }

    s = s.replace(/-it$/, ""); // gemma instruction-tuned
    s = s.replace(/-preview$/, "");
    s = s.replace(/-beta\d*$/, "");
    // -v1, -v1.0, -v0.1 are variant tags (nova-pro-v1, mixtral-instruct-v0.1).
    // But in `deepseek-v3` the same shape IS the model version, and stripping
    // it leaves the bare vendor name. Keep it when nothing meaningful remains.
    s = s.replace(/-v\d+(\.\d+)*$/, (m, _g, offset) =>
      s.slice(0, offset).includes("-") ? "" : m
    );
    // Bare date stamps. The dot form appears when the version-separator rule
    // already fired: gpt-4-0125 -> gpt-4.0125.
    s = s.replace(/-\d{4}$/, "").replace(/\.\d{4}$/, "");

    for (const q of QUANT_SUFFIXES) {
      if (s.endsWith(`-${q}`)) s = s.slice(0, -(q.length + 1));
    }

    if (s === before) break;
  }

  return s;
}

/**
 * Candidate loose keys for one model.
 *
 * Some names repeat the vendor (`amazon-nova-pro` vs OpenRouter's `nova-pro`),
 * but some legitimately start with it (`mistral-small-...` is called that on
 * both sides). Stripping unconditionally breaks the second case, so instead we
 * offer both forms as candidates and let the index decide. Applied identically
 * to both sources, which is what keeps it symmetric.
 */
export function looseKeys(raw, org = null) {
  const base = looseCore(raw);
  const keys = [base];

  const orgs = [];
  if (org) orgs.push(String(org).toLowerCase());
  const slash = String(raw).indexOf("/");
  if (slash > 0) orgs.push(String(raw).slice(0, slash).toLowerCase());

  for (const o of orgs) {
    if (!base.startsWith(`${o}-`) || base.length <= o.length + 1) continue;
    const rest = base.slice(o.length + 1);
    // `mistral-large` -> `large` is an adjective, `deepseek-v3.1` -> `v3.1`
    // is a bare version. Neither identifies a model. Require a compound name.
    if (rest.includes("-")) keys.push(rest);
  }

  return [...new Set(keys)];
}

export const canon = strictBase;
export { looseCore };

/**
 * Which of two OpenRouter records should represent a model.
 * A plain id beats a `:variant` id; otherwise the shorter id wins.
 */
function preferOver(candidate, incumbent) {
  const cVariant = candidate.id.includes(":");
  const iVariant = incumbent.id.includes(":");
  if (cVariant !== iVariant) return !cVariant;
  return candidate.id.length < incumbent.id.length;
}

/**
 * Builds strict + loose lookup indexes over one catalogue.
 */
function buildIndexes(records) {
  const strictIndex = new Map();
  for (const rec of records) {
    const { id } = strictBase(rec.id);
    const existing = strictIndex.get(id);
    if (!existing || preferOver(rec, existing)) strictIndex.set(id, rec);
  }

  const canonical = [...strictIndex.values()];

  const looseIndex = new Map();
  const looseAmbiguous = new Set();
  for (const rec of canonical) {
    for (const key of looseKeys(rec.id)) {
      const existing = looseIndex.get(key);
      if (existing && existing.id !== rec.id) looseAmbiguous.add(key);
      else looseIndex.set(key, rec);
    }
  }

  return { strictIndex, looseIndex, looseAmbiguous };
}

/**
 * @param {Array<object>} arenaModels  normalized arena models (mutated)
 * @param {object} openrouter          map of openrouter id -> pricing record
 * @param {object|null} official       map of models.dev id -> official pricing
 */
export function attachPricing(arenaModels, openrouter, official = null) {
  const records = Object.values(openrouter);

  // OpenRouter lists routing variants of one model as separate ids:
  // `deepseek/deepseek-r1` and `deepseek/deepseek-r1:free`. Collapse them
  // first, preferring the plain id — the `:free` twin is priced at zero and
  // picking it by catalogue order would silently publish $0.00.
  const strictIndex = new Map();
  for (const rec of records) {
    const { id } = strictBase(rec.id);
    const existing = strictIndex.get(id);
    if (!existing || preferOver(rec, existing)) strictIndex.set(id, rec);
  }

  // One record per real model. Building the loose index from this rather than
  // from `records` matters: otherwise a model and its own `:free` twin look
  // like two different models colliding, and the guard blocks a correct match.
  const canonical = [...strictIndex.values()];

  // Loose keys resolving to more than one OpenRouter model are poisoned —
  // we cannot tell which price belongs to which, so we match neither.
  const looseIndex = new Map();
  const looseAmbiguous = new Set();
  for (const rec of canonical) {
    for (const key of looseKeys(rec.id)) {
      const existing = looseIndex.get(key);
      if (existing && existing.id !== rec.id) looseAmbiguous.add(key);
      else looseIndex.set(key, rec);
    }
  }

  // Same guard on the Arena side — but counting *distinct strict keys*, not
  // rows. `gemini-3-flash` and `gemini-3-flash (thinking-minimal)` are two
  // Arena rows for one model: identical strict key, identical price, no
  // ambiguity. Two rows that differ before the loose pass (mistral-large-2411
  // vs -2402) are genuinely different models and must stay blocked.
  const arenaLooseStrictKeys = new Map();
  for (const m of arenaModels) {
    const strictKey = strictBase(m.arena_model_name).id;
    for (const key of looseKeys(m.arena_model_name, m.organization)) {
      if (!arenaLooseStrictKeys.has(key)) arenaLooseStrictKeys.set(key, new Set());
      arenaLooseStrictKeys.get(key).add(strictKey);
    }
  }

  const apply = (m, rec, tier) => {
    m.openrouter_id = rec.id;
    m.released_at = rec.created
      ? new Date(rec.created * 1000).toISOString().slice(0, 10)
      : null;
    m.context_length = rec.context_length;
    m.price_input_per_mtok = rec.price_input_per_mtok;
    m.price_output_per_mtok = rec.price_output_per_mtok;
    m.price_match = tier;
    m.price_source = "openrouter";
  };

  /** an official price overrides whatever OpenRouter said */
  const applyOfficial = (m, hit) => {
    m.price_input_per_mtok = hit.rec.price_input_per_mtok;
    m.price_output_per_mtok = hit.rec.price_output_per_mtok;
    m.price_source = "official";
    m.price_provider = hit.rec.provider;
    m.price_match = hit.tier;
    m.modelsdev_id = hit.rec.id;
    // models.dev states these per model; OpenRouter only knows what it serves.
    m.released_at = hit.rec.released_at ?? m.released_at ?? null;
    m.context_length = m.context_length ?? hit.rec.context_length ?? null;
    m.knowledge_cutoff = hit.rec.knowledge_cutoff ?? null;
  };

  // Official prices are tried first. OpenRouter stays as the fallback and,
  // more importantly, as the "is this model still being served" signal that
  // the currency filter depends on.
  const officialIdx = official ? buildIndexes(Object.values(official)) : null;

  // Note: the official path deliberately skips the Arena-side collision guard
  // used for OpenRouter. It has to — `claude-opus-5` and `claude-opus-5-max`
  // are two Arena rows with different strict keys that should both resolve to
  // the same vendor price, and the guard would block that. The risk is that two
  // genuinely different Arena models collapse onto one official entry. In
  // practice models.dev keeps dated snapshots as separate priced entries
  // (kimi-k2-0905 and kimi-k2-0711 each have their own), so the collapse only
  // happens where the price really is shared. Worth rechecking if a vendor ever
  // prices two snapshots of one family differently.
  const lookupOfficial = (m) => {
    if (!officialIdx) return null;
    const { id } = strictBase(m.arena_model_name);
    const hit = officialIdx.strictIndex.get(id);
    if (hit) return { rec: hit, tier: "strict" };

    for (const key of looseKeys(m.arena_model_name, m.organization)) {
      if (officialIdx.looseAmbiguous.has(key)) continue;
      const loose = officialIdx.looseIndex.get(key);
      if (loose) return { rec: loose, tier: "loose" };
    }
    return null;
  };

  const stats = { strict: 0, loose: 0, ambiguous: 0, official: 0 };
  const unmatched = [];
  const used = new Set();

  for (const m of arenaModels) {
    const { id, mode } = strictBase(m.arena_model_name);
    m.canonical_id = id;
    m.reasoning_mode = mode;

    const officialHit = lookupOfficial(m);

    const strictHit = strictIndex.get(id);
    if (strictHit) {
      apply(m, strictHit, "strict");
      stats.strict += 1;
      used.add(strictHit.id);
      if (officialHit) {
        applyOfficial(m, officialHit);
        stats.official += 1;
      }
      continue;
    }

    const candidates = looseKeys(m.arena_model_name, m.organization);
    let looseHit = null;
    let blocked = false;
    let looseKey = candidates[0];

    for (const key of candidates) {
      const hit = looseIndex.get(key);
      if (!hit) continue;
      if (looseAmbiguous.has(key) || (arenaLooseStrictKeys.get(key)?.size ?? 0) > 1) {
        blocked = true;
        looseKey = key;
        continue;
      }
      looseHit = hit;
      looseKey = key;
      blocked = false;
      break;
    }

    if (looseHit) {
      apply(m, looseHit, "loose");
      stats.loose += 1;
      used.add(looseHit.id);
      if (officialHit) {
        applyOfficial(m, officialHit);
        stats.official += 1;
      }
      continue;
    }

    // Not served by OpenRouter, but the vendor publishes a price — this is the
    // brand-new flagship case (qwen3.8-max, gemini-3-pro).
    if (officialHit) {
      m.openrouter_id = null;
      applyOfficial(m, officialHit);
      stats.official += 1;
      stats[officialHit.tier] += 1;
      used.add(officialHit.rec.id);
      continue;
    }

    if (blocked) stats.ambiguous += 1;

    m.openrouter_id = null;
    m.released_at = null;
    m.context_length = null;
    m.price_input_per_mtok = null;
    m.price_output_per_mtok = null;
    m.price_match = null;
    m.price_source = null;
    unmatched.push({
      arena: m.arena_model_name,
      canonical: id,
      loose: looseKey,
      org: m.organization,
      reason: blocked ? "ambiguous" : "not on openrouter",
    });
  }

  const orphans = records.map((r) => r.id).filter((id) => !used.has(id));

  return { matched: stats.strict + stats.loose, ...stats, unmatched, orphans };
}
