# llm-data

Normalised daily snapshots of LLM leaderboard data, kept in git.

This repo is the **data layer** for the `/models/*` pages. It deliberately does
*not* touch Webflow — that's phase 2. Its only job is to produce a clean,
versioned `data/latest.json` that downstream consumers can trust.

## Why a repo and not a direct sync

A direct `Arena → Webflow` pipeline has no memory. When upstream changes shape
or a model gets renamed, the breakage lands straight on a page that has paid
traffic pointed at it, and there's no way to see what changed or roll back.

Keeping a committed snapshot gives us:

- **History** — every run is a commit, so upstream changes show up as `git diff`
- **Rollback** — a bad day is one revert away
- **Trend data** — after a few months we have per-model score history for free,
  which is its own content asset
- **Portability** — if the pages ever move off Webflow CMS, the data layer
  doesn't change at all

## Sources

| Data | Source | Licence |
|---|---|---|
| Arena Score, rank, votes | `lmarena-ai/leaderboard-dataset` on Hugging Face | CC-BY-4.0 |
| Context window, cross-check pricing | `openrouter.ai/api/v1/models` | see below |

Arena has no public API. It publishes official leaderboard snapshots to Hugging
Face, which we read through the public `datasets-server` REST endpoint. No auth,
no scraping, no key.

**Attribution is mandatory.** CC-BY-4.0 requires crediting the source anywhere
this data is published. Every page rendering these numbers needs a visible
credit linking to <https://arena.ai/leaderboard>.

**Arena does not publish daily.** New snapshots appear roughly weekly, tagged
with `leaderboard_publish_date`. The cron runs daily so we pick up a new
publication within 24h, but the numbers themselves will sit still between
publications. Pages should say *"Data as of {published_at}"*, never
*"updated daily"*.

**OpenRouter prices are not vendor list prices.** They're the provider price
plus OpenRouter's service fee, so they sit slightly above what the vendor
charges directly. Any page publishing them must say so. `WITHOUT_PRICING=1`
skips the fetch entirely.

Matching between the two sources is done in `src/match.js` by canonical name,
not by a lookup table. Arena writes `claude-opus-4-6-thinking`, OpenRouter
writes `anthropic/claude-opus-4.6` — the differences (org prefix, dot vs dash
version separators, reasoning-mode suffix, trailing dates) are systematic and
normalise away. Reasoning modes collapse onto the base model because they share
a price; `-fast` / `-mini` variants deliberately do not, because they don't.

Arena lists more models than OpenRouter serves, so full coverage is not
expected. Run with `SHOW_UNMATCHED=1` to see what didn't match — a sudden drop
in coverage means `canon()` has drifted from upstream naming.

## Usage

```bash
node src/snapshot.js --dry-run   # fetch + validate + print, write nothing
node src/snapshot.js             # write data/ if anything changed
```

Zero dependencies, Node 20+.

## What gets written

```
data/
├── latest.json              # current state — this is what consumers read
└── snapshots/
    └── 2026-07-02.json      # one per Arena publication date
```

`latest.json` is only rewritten when the actual numbers change. A run that
finds nothing new exits 0 and leaves the tree clean, so the commit history
stays meaningful instead of filling up with no-op commits.

## Failure behaviour

Nothing gets written unless it passes the gates in `src/validate.js`:
partial pagination, an implausible score range, a missing publish date, or a
suspiciously short leaderboard all abort the run with exit 1. The workflow
alerts to Telegram on failure.

The principle: **the repo is assumed publishable.** Anything questionable dies
before it lands, rather than being cleaned up downstream.

Score movements over 30 points, new models, and disappearing models are logged
as warnings but do **not** block the snapshot — this repo's job is to record
reality. The gate on *publishing* those numbers lives in the phase-2 sync.

## Setup

1. Push to GitHub, enable Actions
2. Settings → Actions → General → Workflow permissions → **Read and write**
3. Optional secrets for alerts: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
4. Run the workflow manually once to seed `data/latest.json`

## Phase 2 — Webflow sync (not built yet)

Blocked on the content team filling in the `arena-model-name` field in the
Webflow CMS while they populate the MVP by hand. That field is the join key,
and no script can infer it reliably: Arena calls a model
`claude-opus-4-6-thinking`, OpenRouter calls it `anthropic/claude-opus-4-6`,
and the site calls it something else again.

When that's in place, the sync reads `data/latest.json`, matches on
`arena-model-name`, and writes numeric fields only via
`PATCH /v2/collections/:id/items/live` — up to 100 items per request, no site
publish needed, so it never disturbs unfinished work in the Designer.

Rules for that sync, decided up front:

- it **updates** items, never creates or deletes them
- an unmatched `arena-model-name` is an alert, not a silent skip
- it never writes null or zero — a missing value leaves yesterday's number in place
- new model / disappeared model / price moved >10% → alert and skip the write,
  a human decides
