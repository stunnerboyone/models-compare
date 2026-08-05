/**
 * Normalises raw source rows into OUR schema.
 *
 * This file is the only place that knows what upstream looks like.
 * If Arena or OpenRouter change their shape, this is the file that changes —
 * consumers (Webflow sync, future Astro app) never see upstream field names.
 */

import { attachPricing } from "./match.js";

const round = (n, d = 1) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.round(n * 10 ** d) / 10 ** d
    : null;

/**
 * @param {Array<object>} arenaRows  raw rows from the arena source
 * @param {object|null} openrouter   map of openrouter id -> pricing info
 */
export function normalize(arenaRows, openrouter = null, official = null) {
  const publishDates = new Set(
    arenaRows.map((r) => r.leaderboard_publish_date).filter(Boolean)
  );

  if (publishDates.size !== 1) {
    throw new Error(
      `normalize: expected exactly one leaderboard_publish_date, got ${publishDates.size}`
    );
  }

  const publishedAt = [...publishDates][0];

  // model_name -> record. One entry per model, with a rating per category.
  const models = new Map();

  for (const row of arenaRows) {
    const key = row.model_name;
    if (!key) continue;

    if (!models.has(key)) {
      models.set(key, {
        // Stable join key. This is the value the content team must copy into
        // the `arena-model-name` field in the Webflow CMS.
        arena_model_name: key,
        organization: row.organization ?? null,
        license: row.license ?? null,
        categories: {},
      });
    }

    const entry = models.get(key);
    const category = row.category || "overall";

    entry.categories[category] = {
      score: round(row.rating),
      score_lower: round(row.rating_lower),
      score_upper: round(row.rating_upper),
      rank: row.rank ?? null,
      votes: row.vote_count ?? null,
    };
  }

  const list = [...models.values()].map((m) => {
    const overall = m.categories.overall ?? null;

    return {
      ...m,
      // Flattened for convenience — this is what the table renders.
      arena_score: overall?.score ?? null,
      arena_rank: overall?.rank ?? null,
      arena_votes: overall?.votes ?? null,
    };
  });

  list.sort((a, b) => (b.arena_score ?? -Infinity) - (a.arena_score ?? -Infinity));

  let match = null;
  if (openrouter) {
    match = attachPricing(list, openrouter, official);
  }

  const payload = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    arena: {
      published_at: publishedAt,
      source: "https://arena.ai/leaderboard",
      license: "CC-BY-4.0",
      attribution_required: true,
    },
    models: list,
  };

  if (openrouter) {
    payload.pricing = {
      fetched_at: new Date().toISOString(),
      sources: {
        official: "https://models.dev/api.json",
        fallback: "https://openrouter.ai/api/v1/models",
      },
      unit: "USD per 1M tokens",
      note:
        "Each model carries price_source: 'official' is the vendor's own list price from models.dev and can be published as such; 'openrouter' includes OpenRouter's service fee and must be labelled accordingly.",
      matched: match.matched,
      official: match.official,
      matched_strict: match.strict,
      matched_loose: match.loose,
      blocked_ambiguous: match.ambiguous,
      unmatched: match.unmatched.length,
      // Coverage on the models that will actually appear on a page. The
      // long tail (vicuna, llama-2, gpt-4-0613) is unmatched because
      // OpenRouter stopped serving it, which is not a defect to chase.
      coverage_top50: list
        .slice(0, 50)
        .filter((m) => m.price_match).length,
      unmatched_models: match.unmatched,
    };
  }

  return payload;
}
