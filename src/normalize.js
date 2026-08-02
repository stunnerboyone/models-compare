/**
 * Normalises raw source rows into OUR schema.
 *
 * This file is the only place that knows what upstream looks like.
 * If Arena or OpenRouter change their shape, this is the file that changes —
 * consumers (Webflow sync, future Astro app) never see upstream field names.
 */

const round = (n, d = 1) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.round(n * 10 ** d) / 10 ** d
    : null;

/**
 * @param {Array<object>} arenaRows  raw rows from the arena source
 * @param {object|null} openrouter   map of openrouter id -> pricing info
 */
export function normalize(arenaRows, openrouter = null) {
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

  const payload = {
    schema_version: 1,
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
    payload.openrouter = {
      fetched_at: new Date().toISOString(),
      source: "https://openrouter.ai/api/v1/models",
      note:
        "Prices include OpenRouter's service fee and are NOT official vendor list prices.",
      models: openrouter,
    };
  }

  return payload;
}
