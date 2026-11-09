# Session handoff — Mercur marketplace performance benchmark

Last updated: 2026-11-09 (evening). Branch: `main`, nothing committed yet;
plan steps 3–5 are implemented in the working tree (see "Code changes" below).

## Goal

Run the marketplace version of Medusa's cache benchmark against Mercur on
Medusa Cloud and publish an article with the numbers plus a practical
"how to make Mercur/Medusa fast at marketplace scale" guide. All scripts,
seeds and results live in this repo under `perf/`.

Reference benchmark: https://medusajs.com/blog/medusa-cache-benchmarks and
its k6 script
https://github.com/medusajs/medusa/blob/623ee92f32fdd6fdaf29ad1b9755f1e0de492390/scripts/load/mid-sized-dtc-checkout.js
(Grafana Cloud k6, `amazon:de:frankfurt`, 420 VUs = 300 browse + 4×30 shop
scenarios, 2m ramp / 6m steady / 2m ramp down, 2–5 s think time, p95 per
scenario, failure rate < 1%). Medusa's results: p95 680 ms (2.10.1) →
496 ms (2.11.0) → 309 ms (2.11.0 + Medusa Cache), ~145 RPS avg, ~200 peak,
on 1 vCPU / 2 GB pods, Postgres 1–4 vCPU autoscaling.

Target environment: `https://mercur.medusajs.app` (Medusa Cloud, project
"Mercur", env "Production", Postgres 16).

## Guidance from Medusa Cloud (keep to it)

- Ramp gradually; a 0→420 burst needs pre-scaling because autoscaling takes
  1–2 min. Medusa's 2-minute ramp is fine.
- Enable instrumentation, run ~20 VUs first, fix the obvious hot spots in the
  codebase, then scale up.

## What exists

| Path | What |
| --- | --- |
| `apps/api/src/scripts/perf/seed-marketplace.ts` | Deterministic, resumable seed. Presets `smoke` (200 products / 10 sellers), `large` (50k / 500, ~500k offers), `heavy` (500k / 2k, ~5M offers). Creates 4 regions (EUR Europe+Nordics with tax, USD US no tax, USD Canada with tax), categories, collections, Size/Color attributes, `10OFF` promo, publishable key "k6 load test", per-seller warehouse + service zone + Standard/Express shipping, offers with EUR/USD prices and 1M stock, and an admin user `admin@mercur.dev` (password from `PERF_ADMIN_PASSWORD` or printed once). Writes `perf/fixtures/<preset>.json`. Env knobs: `PERF_CONCURRENCY` (4), `PERF_PRODUCT_BATCH`, `PERF_OFFER_BATCH`, `PERF_PRODUCTS`, `PERF_SELLERS`, `PERF_ENDPOINT`. Type-checks clean; excluded from `medusa build` via tsconfig. |
| `perf/export-dump.sh <db> [out]` | Makes a Medusa-Cloud-importable dump: copies the DB, drops Index-module objects (`index_*` tables, their `cat_*` partitions, `update_document_tsv()`), dumps with pg_dump **16**. |
| `perf/k6/mercur-marketplace.js` | Medusa's scenarios ported to Mercur. Reads `perf/fixtures/$DATASET.json`. Env: `DATASET`, `SCALE` (VU multiplier), `RAMP`, `STEADY`, `ENDPOINT`, `CLOUD=1` + `K6_PROJECT_ID` + `LOAD_ZONE`. Differences from Medusa: `offer_id` in line items, product list uses `fields=*variants.calculated_price,+variants.offer_id`, random `offset` over the whole catalog, extra `GET /store/offers?product_id` step, shipping options grouped by seller → one `POST shipping-methods` per seller (to be batched, see below), completion returns `order_group`, payment provider `pp_system_default`, custom counters `orders_placed`, `order_seller_splits`. |
| `perf/fixtures/smoke.json` | Matches the current dump and the data now on Medusa Cloud. Key `pk_e9d970b5…`, region ids `reg_01M70H19…`. |
| `perf/results/` | `smoke-functional.json` (5 VUs), `smoke-20vu-summary.json`, `smoke-20vu.log`, `smoke-20vu.csv` (4.6 MB per-request; probably don't commit). |
| `perf/README.md` | Seeding, dump/import procedure, Index rebuild, run order. |
| `mercur_perf_smoke.dump` (repo root, 1.6 MB) | Postgres 16 dump of the smoke dataset, **without** the admin user (seed gained it afterwards). Imported into Medusa Cloud successfully. Add `*.dump` to `.gitignore` before committing. |

Local state: a Postgres 16 server (Homebrew `postgresql@16`, keg-only) with
data dir in the session scratchpad `…/scratchpad/pg16`, port 5433, DB
`mercur_perf_smoke` seeded. It is stopped. The scratchpad is session-specific,
so a new session must re-init: `initdb`, `pg_ctl start -o "-p 5433"`,
`createdb`, `medusa db:migrate`, run the seed. Postgres 18 on 5432 also has a
`mercur_perf_smoke` DB from the first attempt (not Cloud-compatible). Local
Redis is shared with another running project; do not FLUSHDB.

## Lessons learned (don't repeat)

- Medusa Cloud import needs pg_dump 16 archives (format 1.15). pg_dump 18
  fails with "Version mismatch (1.16)".
- Import restores with `--clean` over a migrated DB; Index-module partitions
  (`cat_seller_pkey` inherited constraint) and the `update_document_tsv`
  trigger function make it fail. Hence `export-dump.sh`.
- Imported rows never reach the Index module. `/store/offers` reads from the
  Index when enabled, so it returned `200` with an empty list in the 20-VU
  run. After each import: log in as the admin and
  `POST /admin/index/sync {"strategy":"reset"}`, wait, verify via
  `GET /admin/index/details`. The current Cloud DB has no admin user yet.
- Mercur's `/store/products` middleware drops the `sales_channel_id` filter
  (see hot spots), so the list never uses the Index anyway.
- `createOffersWorkflow` links all created inventory items to the first
  offer's seller: never mix sellers in one batch. Variant price sets are
  pre-created before offers so parallel seller batches don't race.
- All seeded sellers share password `supersecret` on a public backend; fine
  for a disposable env, not long-term.
- Repo switched from bun to yarn 4 (commit b3cb75bf); CLAUDE.md still says
  bun. Use `yarn` / `node_modules/.bin/medusa`.
- `k6` v2.3.0 is installed locally. Grafana Cloud k6 free tier ≈ 500 VUh/mo;
  a full 420-VU run ≈ 56–70 VUh. Debug locally with `k6 run`, publish from
  Grafana Cloud.

## Results so far (smoke data, run from laptop → Medusa Cloud, 23 VUs)

5-VU functional pass: all 14 flows pass, 0 failed requests.

23-VU run (SCALE=0.05, 1m/3m/1m): 2,308 requests, ~7 RPS, 0% failed,
overall p95 820 ms / p50 157 ms, 14 orders placed split into 34 seller orders.
Medusa thresholds failed for browse (669 ms > 400) and add-multiple
(928 > 700).

| p95 | p50 | Endpoint |
| --- | --- | --- |
| 1727 | 1225 | POST /store/carts/:id/complete |
| 1608 | 916 | POST /store/carts/:id/shipping-methods (once per seller) |
| 1089 | 581 | POST /store/carts/:id/line-items |
| 1052 | 557 | POST /store/carts/:id (address) |
| 1007 | 456 | GET /store/products (offer prices) |
| 828 | 173 | POST /store/payment-collections |
| 712 | 252 | GET /store/shipping-options?cart_id |
| 671 | 198 | GET /store/products/:id |
| 570 | 110 | GET /store/offers (empty, Index not synced) |
| ~530 | ~70 | trivial endpoints (collections, regions, customers/me) |

Trivial endpoints' p95 rises with load (372 → 592 ms over the ramp, 145 ms
during ramp-down) while p50 stays ~70–100 ms → queueing on the 1-vCPU pod,
not a single slow request type. More pods would trim p95 but not the medians;
medians are per-request work. Numbers include laptop→Cloud network (~50 ms
floor), so they're for finding hot spots, not publishing.

## Hot spots found (code-traced, line refs verified), ranked

Caching IS on: `withMercur` enables the `caching` flag and
`@medusajs/medusa/caching-redis` by default. Only the main product query is
cached; the hot work below is not.

Checkout (`workflows/cart/workflows/complete-cart-with-split-orders.ts`):
1. `:671` `splitCapturedCartPaymentWorkflow.runAsStep` runs always; it's a
   stored workflow (store:true, 3-day retention, own lock, ~12 checkpoints)
   but the system provider only AUTHORIZES, so the plan is empty. Gate on
   `payment.captures.length`; the `payment.captured` subscriber covers later
   captures.
2. `:679` `refreshOrderCommissionLinesWorkflow` (also stored) re-reads the
   new orders with a heavy graph (items, adjustments, totals, categories,
   tags, attribute values, offer link) and lists existing lines twice. Build
   the context from `cartData` + `createdOrders` and create lines directly,
   or move to an `order.placed` subscriber. Then parallelize with the block
   at `:634`.
3. Order group looked up twice via the aggregate repo
   (`order-group/steps/create-order-group.ts:20` + route final read).
4. Minor: merge the two `link.create` calls (`:635-638`); telemetry milestone
   runs on every `order_group.created`.
   Estimated: ~110–130 queries → ~75–85, 3 stored workflows → 1, 2 locks → 1.

Carts:
5. `add-seller-shipping-method-to-cart.ts:58,167`: each call prices options
   then runs the full `refreshCartItemsWorkflow`; N sellers = N refreshes.
   Route and Medusa validator already accept an array → send all sellers'
   options in one call (fix k6 + storefront). Bug: `route.ts:22`
   `payload.additional_data` is undefined for array payloads.
6. `workflows/cart/hooks/set-pricing-context.ts:118-137`: every refresh does
   `removeOrphanSellerShippingMethods` (2 queries) + `collectFromCartItems`
   (1), result only used under `force_refresh`;
   `before-refreshing-payment-collection.ts:22` reads cart→offer again and
   `link.create`s every refresh. Collapse to one graph read in the pricing
   hook, create links there, drop the second hook.
7. `workflows/cart/hooks/validate.ts:222-258` (add-to-cart): 4 sequential
   reads of cart→offer / offer inside the cart lock, route already loaded the
   offer; plus Medusa's variant inventory check. One cart read + one offer
   read, `promiseAll`, pass offer via `additional_data`.
8. `workflows/offer/utils/prepare-offer-inventory-input.ts:12-25`: 6-stage
   joiner chain per add; stop at `location_levels`, cache sales-channel
   locations.
9. `POST /carts/:id` with address → Medusa `force_refresh` reprice. Client
   fix: set email/address at `POST /store/carts`.
10. `line-items/route.ts:48` always returns full `defaultStoreCartFields`,
    ignores `?fields=`; add `validateAndTransformQuery`.
11. `list-seller-shipping-options-for-cart.ts:29-80`: serial location reads;
    parallelize, trim `location_levels.*`.

Products (`api/utils/offers.ts`, `api/store/products/*`):
12. `offers.ts:260-299` offer-price wrap: `query.graph` on offer with
    `product_variant.price_set.id` + `prices.id` = ~6 serial hops (incl. all
    ~400 price rows just to map price→offer); `calculatePrices` gets
    `offer_id` as a ~200-value array → 200-value IN inside a LATERAL per
    candidate price. Fix: `variants.price_set.id` in the cached main query,
    drop `prices.id`, resolve offers for winning prices via one `price_rule`
    lookup, `useCache` the step.
13. `store/products/middlewares.ts:93-127`: Medusa's pricing/tax middlewares
    run AND Mercur's run again (2 uncached region reads, double validation);
    Mercur's `validateAndTransformQuery` rebuilds `filterableFields` and
    DROPS `sales_channel_id` (correctness bug; also why Index is unused).
14. `query-config.ts:42-63` requests `product_attribute_values.attribute.values.*`
    which returns empty, then `enrichProductAttributes` fetches again.
15. Tax lines per request (`offers.ts:371-375`); cache per region+country.
16. Cache the final priced page (key: page + region + customer group); at
    50k products the offset-keyed main-query cache collapses.
    Per list request: today ~14–17 sequential queries on cache hit (~28–32
    on miss) → ~4–5 after 12–15 → 0 DB after 16.

Ruled out: stored workflows on add/refresh paths (none); `POST /store/carts`
is plain Medusa (its tail is queueing); promotion seller-scope patch only
runs with adjustments.

## Agreed plan (next steps, in order)

1. Script-side, no server change: batch shipping methods into one call (#5);
   set email + address at cart creation (#9). Re-run 20 VUs to separate flow
   shape from code cost.
2. Checkout: gate payment split (#1), take commission out of the stored
   request path (#2).
3. Products: offer-price wrap (#12), middleware double-run + `sales_channel_id`
   (#13).
4. Collapse refresh/validate hooks (#6, #7).
5. Cache priced page + tax rates (#15, #16) as its own measured run (the
   "with cache" column of the article).
Each as a separate measurable PR → gives the article its before/after story.

## Code changes landed this session (plan steps 3–5, uncommitted, unmeasured)

All in `packages/core/src`, type-check clean, `yarn build` for core passes.
Steps 1–2 of the plan were NOT done (no k6 script change, no checkout change).

Step 3 — products:
- `api/utils/offers.ts` `wrapProductVariantsWithOfferPrice`: the 6-hop offer
  read (`product_variant.price_set.id` + all `prices.id`) is gone. Routes add
  `variants.price_set.id` to the (cached) main product query
  (`withVariantPriceSetField`, stripped from the response), the offer read is a
  single-table `offer {id, variant_id} where variant_id in (...)`, and the
  winning price → offer mapping comes from one `listPriceRules({ price_id,
  attribute: "offer_id" })` call. Per priced page: 3 pricing queries instead of
  ~8, no 400-row price fetch. `offer_id` still goes into `calculatePrices` as an
  array (needed for rule matching), so the IN list inside the LATERAL remains.
- `api/store/products/middlewares.ts`: CORRECTION to hot spot #13. Medusa's
  own `/store/products` middlewares are already disabled by
  `utils/disable-medusa-middlewares.ts`, so there was no double run. What was
  real: `setTaxContext` re-read the region uncached, and `sales_channel_id` was
  never applied. Now one `setOfferPricingContext` middleware does a single
  cached region read (id, currency_code, automatic_taxes) for both contexts.
  `sales_channel_id` is honored only when the client passes it explicitly
  (validated against the publishable key → 400 otherwise); it stays on the
  request when the Index can serve the list, else it becomes a
  `product_sales_channel` link filter (always on the detail route). Implicit
  key-based scoping was tried and reverted: vendor-created products are never
  linked to a channel, so it emptied the catalog in every multi-channel store
  (the product spec showed it immediately). Product decision for the user.
  Consequence: the Index is still unused for a plain `/store/products` list.
- `api/utils/list-products.ts` exports `canUseProductIndex` /
  `toProductIndexFilters` so the middleware and `listProducts` agree.
- Validators accept `country_code`, `province`, `cart_id`, `sales_channel_id`.

Step 4 — cart hooks:
- `workflows/cart/hooks/set-pricing-context.ts` (refresh hook): one cart read
  (`items.id/offer.id/offer.seller_id/metadata`, `shipping_methods.*`) feeds
  orphan shipping-method removal (shipping_option read only when methods
  exist), line↔offer link creation (moved here from the deleted
  `before-refreshing-payment-collection.ts` hook) and the offer ids. 4 queries
  → 1 on the browse/add path, 2 at checkout.
- `workflows/cart/hooks/validate.ts` (add-to-cart): 4 sequential reads → 2
  (cart lines with variant_id, then offers incl. `seller_id` + inventory
  fields); the three checks run on the pre-read rows.
- `remove-orphan-seller-shipping-methods.ts` split into
  `removeOrphanSellerShippingMethodsFromCart(container, cartRows)` + the old
  id-based wrapper.

Step 5 — caching (the "with cache" column):
- `useCache` around the offer-price computation, key = variant→price-set map +
  pricing context (region, currency, customer groups), tags `Price*`, `Offer`,
  `LinkOfferPrice` lists, TTL `MERCUR_STORE_PRICE_CACHE_TTL` (default 60 s).
- `useCache` around `getTaxLines`, key = address + (variant, product,
  currency) tuples, tags `TaxRate*`/`TaxRegion`, TTL `MERCUR_STORE_TAX_CACHE_TTL`
  (default 300 s). Set either to `0` to disable → the same build gives the
  "before cache" and "with cache" runs. Caching is keyed on variant sets, so the
  detail page shares entries with the list page. Invalidation relies on TTL
  where the pricing module emits no entity event — verify on Cloud before
  publishing the number.

Second pass — the remaining hot spots (same day, also uncommitted):

Checkout (`complete-cart-with-split-orders.ts`):
- #1 `splitCapturedCartPaymentWorkflow` only runs when the authorized payment
  has a capture (`payment.captures.length`), as a top-level `when` after the
  order block — the composer does not nest `when`, and a `when` block that
  returns a plain object becomes a step named after the block, so the block is
  now `complete-cart-orders` (it collided with the `create-order-group` step).
- #2 commission lines: the contexts are built in a `transform` from the cart
  (items/shipping methods matched to the new orders by seller and position;
  `completeCartFields` gained `items.variant.product.{categories,tags,
  attribute_values}.id`) and passed as `contexts` into
  `refreshOrderCommissionLinesWorkflow`, which now resolves them through
  `resolveCommissionContextsStep` (no fetch when given) and creates instead of
  upserting (`create_only`, no "existing lines" lookups). It runs in the
  parallel block with the links, cart update, reservation and events. Still
  `store: true`.
- #3 `createOrderGroupStep` takes `existing_id` from the up-front order-group
  query instead of listing by cart_id again.
- #4 order-line ↔ offer links are part of `createLinksStep`'s batch;
  `mirrorLineItemOfferLinksToOrderStep` is no longer called (file kept).
- #5 `recordMilestone` keeps a process-level set of settled milestones.
Cart:
- #7 `shipping-methods/route.ts` reads `additional_data` from the first array
  entry.
- #8 NOT done: `refreshCartShippingMethodsWorkflow` has no input for
  pre-priced options (it always runs `listShippingOptionsForCartWithPricing`),
  so skipping the re-pricing needs a core-flows patch. Left as is.
- #9 add-to-cart validate: cart lines + sales-channel locations are read in
  `promiseAll`, then one offer read; the route's offer row is not threaded
  through `additional_data` (the hook needs inventory fields the route does
  not load, so it would not save a query).
- #10 `requiredOfferFieldsForInventoryConfirmation` stops at
  `location_levels`; sales-channel membership comes from
  `resolveSalesChannelLocationIds` (cached `sales_channels.stock_locations.id`
  read, tags `SalesChannel:list:*` + `LinkSalesChannelStockLocation:list:*`).
  `prepareOfferInventoryInput` takes `channel_location_ids` and falls back to
  the old relation when absent (unit tests unchanged). Checkout reads the
  locations in its parallel block.
- #11 `POST /store/carts/:id/line-items` runs Medusa's
  `validateAndTransformQuery(StoreGetCartsCart, retrieveTransformQueryConfig)`
  and returns `req.queryConfig.fields`.
Products:
- #14 `product_attribute_values.attribute.values.*` dropped from the store
  defaults; `enrichProductAttributes` caches its attribute read for 1 h
  (tags `ProductAttribute:list:*`, `ProductAttributeValue:list:*`).
- #16 is the variant-set cache from the first pass (same hit rate as a page
  cache for a page, plus sharing between list and detail).

Second-pass verification: `http/order/store/` 16/16,
`payment-webhook-cart-completion` 5/5, `commission-calculation` 8/8,
`http/offer/cart/` 29+1 skipped, `http/offer/order/` 7/7,
`http/product/store/` 32/32, `http/promotions/store/` 9/9, unit
`workflows/(cart|offer|commission)` 15/15.

Verified locally (Postgres 5432, in-memory cache, Index on):
`http/product/store/product.spec` 23/23 (4 new sales-channel tests),
`offer-product-price` + `product-fields` 7/7, `http/offer/cart/` 29 passed /
1 skipped, `http/offer/order/` 7/7, unit `workflows/(cart|offer)` 15/15.
Note: the magento2 connector plugin must be compiled
(`packages/plugins/magento2-connector`: `tsc --declaration --outDir
.medusa/server`) or every integration spec fails at container boot.

Not re-measured: no k6 run after these changes. Next: deploy, run the 20-VU
smoke with `MERCUR_STORE_PRICE_CACHE_TTL=0` and again with the default, then
do plan steps 1–2.

Also pending:
- Re-seed/export so the Cloud DB gets the admin user, re-import, run the
  Index reset so `/store/offers` returns data.
- Enable OpenTelemetry in `apps/api/instrumentation.ts` (currently all
  commented; needs an exporter package).
- Seed `large` (~45 min est.) and `heavy` (8 h+ est.) on Postgres 16, export,
  import; time `large` first.
- Decide publishing runs: Grafana Cloud k6 (~$0–100 for 4–15 runs) vs. a VM
  in the same AWS region.
- Rerun per the article: Mercur baseline → after fixes → with cache, two
  dataset sizes.
- `.gitignore` for `*.dump` and large CSVs; then commit `perf/` and the seed
  (user must ask before committing).
