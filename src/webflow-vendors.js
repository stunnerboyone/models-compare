/**
 * The Webflow side of "which Arena models belong to which vendor page".
 *
 * Shared by webflow-seed.js, which creates the Model Versions drafts, and
 * webflow-sync.js, which reports when Arena moves a model into a vendor's
 * top-N and the CMS has not caught up. The two have to agree on the
 * selection: if they drift, the seed creates items the sync then flags, or
 * the sync keeps suggesting something the seed would never create.
 *
 * Not to be confused with config/vendors.json, which decides what each
 * /models/<vendor> page renders. That one is keyed by page slug and matches
 * on name prefixes; this one is keyed by the item name in the Webflow
 * "Models" collection and maps it to an Arena organization.
 */

// Vendor label (the item's name in the Models CMS) -> Arena organization.
// namePrefix is an optional escape hatch: Arena bundles some non-Llama
// models under organization "meta" (muse-spark-*), so Llama explicitly
// restricts to arena_model_name starting with "llama". Add the field to
// any other vendor that ends up in the same situation.
export const VENDORS = [
  { label: "ChatGPT",    org: "openai" },
  { label: "Claude",     org: "anthropic" },
  { label: "Gemini",     org: "google" },
  { label: "DeepSeek",   org: "deepseek" },
  { label: "Grok",       org: "xai" },
  { label: "Llama",      org: "meta", namePrefix: "llama" },
  { label: "Mistral",    org: "mistral" },
  { label: "Qwen",       org: "alibaba" },
  { label: "Copilot",    org: "openai" },
  { label: "Perplexity", org: "perplexity" },
];

export const VENDOR_BY_LABEL = new Map(VENDORS.map((v) => [v.label, v]));

// Unranked sorts last rather than nowhere, so a model with no Arena rank
// only reaches a top-N that has room left over. A sentinel rather than
// Infinity: Infinity - Infinity is NaN, which makes a comparator lie.
const UNRANKED = Number.MAX_SAFE_INTEGER;

/** Sort value for an Arena rank, including a missing one. */
export const rankValue = (rank) => rank ?? UNRANKED;

const rankOrder = (model) => rankValue(model.arena_rank);

/**
 * A vendor's strongest base models, best Arena rank first.
 *
 *   organization    must match, narrowed by namePrefix where set
 *   reasoning_mode  null only — the site convention is base variants, so
 *                   claude-opus-5-high is not a separate page entry
 *   requirePrice    drops models with no price. The seed needs that: it
 *                   creates page entries, and an entry with no price reads
 *                   as broken. The sync's top-N check does not — a model is
 *                   often on the leaderboard before any price shows up, and
 *                   that is exactly when it is worth flagging.
 */
export function pickVendorTop(models, { org, namePrefix }, { limit, requirePrice = true } = {}) {
  let list = models
    .filter((m) => m.organization === org)
    .filter((m) => m.reasoning_mode === null);

  if (requirePrice) list = list.filter((m) => m.price_input_per_mtok != null);
  if (namePrefix) list = list.filter((m) => m.arena_model_name?.startsWith(namePrefix));

  return list.sort((a, b) => rankOrder(a) - rankOrder(b)).slice(0, limit);
}
