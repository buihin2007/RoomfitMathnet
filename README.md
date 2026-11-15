# Roomfit

Measure your corner once. Roomfit reads shop pages live through Context.dev and shows the furniture sets that fit side by side.

Built for the Junction 2026 challenge "The Web Is Your Real-Time Database" by Context.dev.

## Run it

Requires Node 18 or newer. No dependencies, no build step.

```bash
cp .env.example .env      # then paste your key after CONTEXT_DEV_API_KEY=
node server.mjs           # http://127.0.0.1:3000
```

Other commands:

```bash
node --test               # fit algorithm tests
MOCK=1 node server.mjs    # UI with invented data, no API calls (clearly labelled)
```

## How it works

1. Search: `POST /v1/web/search` per furniture type, Finnish market, limited to a list of furniture shops.
2. Read: `POST /v1/web/scrape` per product page with two formats in one call:
   - `json` with a schema for assembled width, depth, height or diameter, unit and a verbatim evidence quote
   - `product` for name, price, currency, availability and image
3. Normalise: units to whole millimetres, round items use their diameter, package dimensions are ignored, implausible footprints are dropped.
4. Fit: `sum(width) + (n - 1) * gap <= wall width` and `max(depth) <= corner depth`, see `public/fit.mjs`.
5. Re-check: `maxAgeMs: 0` forces a fresh read of a set's pages. Price, stock and size changes go to the change log, and sets that no longer fit or are sold out disappear.
6. Watch: re-reads a set every 60 seconds for up to 30 minutes.

## What the labels mean

- "fresh from the shop page": Context.dev fetched the page for this request (`cache_metadata.status` is `miss`).
- "cached copy, N min old": a recent copy was reused. The first search accepts copies up to 15 minutes old, configurable with `SEARCH_MAX_AGE_MS`.
- "Evidence": the quote the dimensions were taken from.
- Products without verifiable dimensions are counted and left out, never guessed.

## Limits

- Finnish market, one straight wall, no rotation or L-shapes.
- Delivery to a postcode is not checked: shops do not publish it on product pages.
- Cost per product page: 1 (scrape) + 4 (JSON) + 1 (product) = 6 credits. A watched set of two items uses about 12 credits per minute.

## Files

```
server.mjs          API routes, Context.dev client, normalisation
public/fit.mjs      pure fit algorithm, shared by browser and tests
public/app.mjs      UI, re-check, watch, change log
public/index.html   page and styles
test/fit.test.mjs   boundary tests
```
