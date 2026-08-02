/**
 * Sanity gates.
 *
 * The point of this file: a bad snapshot must never be committed.
 * Whatever is in data/latest.json is assumed downstream to be publishable,
 * so everything questionable dies here, loudly.
 */

// Bradley-Terry ratings have historically sat roughly in the 800-1700 band.
// Anything outside means the scale or the schema changed and a human should look.
const MIN_RATING = 700;
const MAX_RATING = 2000;

const MIN_MODELS = 20;

/**
 * Hard checks — throw. Nothing gets written.
 */
export function validate(payload) {
  const errors = [];

  if (!Array.isArray(payload.models) || payload.models.length === 0) {
    throw new Error("validate: no models in payload");
  }

  if (payload.models.length < MIN_MODELS) {
    errors.push(
      `only ${payload.models.length} models (expected at least ${MIN_MODELS}) — upstream may be serving a partial leaderboard`
    );
  }

  const scored = payload.models.filter((m) => m.arena_score !== null);
  if (scored.length === 0) {
    errors.push("no model has an `overall` category score");
  }

  for (const m of scored) {
    if (m.arena_score < MIN_RATING || m.arena_score > MAX_RATING) {
      errors.push(
        `${m.arena_model_name}: score ${m.arena_score} outside plausible range ${MIN_RATING}-${MAX_RATING}`
      );
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}/.test(payload.arena.published_at ?? "")) {
    errors.push(`bad published_at: ${payload.arena.published_at}`);
  }

  if (errors.length) {
    throw new Error("validate failed:\n  - " + errors.join("\n  - "));
  }
}

/**
 * Soft checks — compared against the previous snapshot.
 * These do not block the commit; they surface as warnings for the alert step,
 * because the whole reason we keep history is to be able to see movement.
 *
 * The hard gate on *publishing* these numbers lives in the Webflow sync
 * (phase 2), not here.
 */
export function diffReport(prev, next) {
  if (!prev) return { first_run: true, warnings: [], changes: [] };

  const warnings = [];
  const changes = [];

  const prevByName = new Map(
    prev.models.map((m) => [m.arena_model_name, m])
  );
  const nextByName = new Map(
    next.models.map((m) => [m.arena_model_name, m])
  );

  for (const [name, m] of nextByName) {
    if (!prevByName.has(name)) {
      changes.push(`NEW MODEL: ${name} (${m.organization}) score ${m.arena_score}`);
      continue;
    }

    const before = prevByName.get(name).arena_score;
    const after = m.arena_score;

    if (before === null || after === null) continue;

    const delta = after - before;
    if (Math.abs(delta) >= 30) {
      warnings.push(
        `${name}: score moved ${delta > 0 ? "+" : ""}${delta.toFixed(1)} (${before} -> ${after})`
      );
    }
  }

  for (const name of prevByName.keys()) {
    if (!nextByName.has(name)) {
      warnings.push(`MODEL DISAPPEARED from leaderboard: ${name}`);
    }
  }

  const dropped = prev.models.length - next.models.length;
  if (dropped > 5) {
    warnings.push(`model count dropped by ${dropped}`);
  }

  return { first_run: false, warnings, changes };
}
