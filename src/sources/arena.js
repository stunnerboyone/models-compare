/**
 * Arena (LMArena) leaderboard via the Hugging Face datasets-server REST API.
 *
 * Arena has no public API of its own, but publishes official snapshots to
 * the `lmarena-ai/leaderboard-dataset` dataset under CC-BY-4.0.
 * Attribution to https://arena.ai/leaderboard is REQUIRED wherever we publish this.
 *
 * We use /filter rather than /rows on purpose. The `latest` split holds every
 * category (overall, coding, math, per-language...) which is ~10k rows — over
 * 100 paginated requests for the ~280 rows we actually want. Filtering server
 * side by category brings that down to three.
 *
 * Docs: https://huggingface.co/docs/dataset-viewer/en/filter
 */

const BASE = "https://datasets-server.huggingface.co/filter";
const DATASET = "lmarena-ai/leaderboard-dataset";

// `text_style_control` is what arena.ai shows by default for the text arena.
const CONFIG = process.env.ARENA_CONFIG || "text_style_control";
const SPLIT = "latest";

// Which leaderboard category to snapshot. `overall` is the headline ranking.
const CATEGORY = process.env.ARENA_CATEGORY || "overall";

const PAGE_SIZE = 100;

// Hard cap so a schema change upstream can never turn into a runaway loop.
// A single category is a few hundred rows; 20 pages is ~7x headroom.
const MAX_PAGES = 20;

function buildUrl(offset) {
  const params = new URLSearchParams({
    dataset: DATASET,
    config: CONFIG,
    split: SPLIT,
    // SQL syntax: column names in double quotes, string literals in single.
    where: `"category"='${CATEGORY.replace(/'/g, "''")}'`,
    orderby: '"rank"',
    offset: String(offset),
    length: String(PAGE_SIZE),
  });
  return `${BASE}?${params}`;
}

async function getPage(offset) {
  const res = await fetch(buildUrl(offset), {
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `arena: HTTP ${res.status} at offset ${offset}. ${body.slice(0, 300)}`
    );
  }

  const json = await res.json();

  if (!Array.isArray(json.rows)) {
    throw new Error("arena: unexpected payload — `rows` is not an array");
  }

  return json;
}

/**
 * Returns the rows of the current published leaderboard for one category.
 * @returns {Promise<Array<object>>}
 */
export async function fetchArena() {
  const first = await getPage(0);
  const total = Number(first.num_rows_total);

  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `arena: no rows matched category '${CATEGORY}' — has the category been renamed upstream?`
    );
  }

  const rows = first.rows.map((r) => r.row);

  let page = 1;
  while (rows.length < total && page < MAX_PAGES) {
    const next = await getPage(page * PAGE_SIZE);
    if (next.rows.length === 0) break;
    rows.push(...next.rows.map((r) => r.row));
    page += 1;
  }

  if (rows.length < total) {
    throw new Error(
      `arena: paginated ${rows.length} of ${total} rows — stopping rather than publishing a partial leaderboard`
    );
  }

  return rows;
}

export const arenaMeta = {
  dataset: DATASET,
  config: CONFIG,
  split: SPLIT,
  category: CATEGORY,
};
