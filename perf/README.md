# Marketplace load tests

k6 benchmarks for Mercur on Medusa Cloud, modelled on Medusa's
[mid-sized DTC benchmark](https://github.com/medusajs/medusa/blob/623ee92f32fdd6fdaf29ad1b9755f1e0de492390/scripts/load/mid-sized-dtc-checkout.js).

## Datasets

| Preset | Products | Sellers | Offers (approx.) |
| ------ | -------- | ------- | ---------------- |
| smoke  | 200      | 10      | 2k               |
| large  | 50,000   | 500     | 500k             |
| heavy  | 500,000  | 2,000   | 5M               |

Each product has 1–5 variants (Size axis, one Color). It is sold by 1–20 sellers,
about 3.4 on average, and each of those sellers sells every variant. Every
offer has EUR and USD prices and 1,000,000 units of stock at its seller's
warehouse, so checkouts never run out of stock during a run.

The seed also creates these, all derived from fixed indexes:

- 4 regions: Europe and Nordics in EUR with tax, United States in USD
  without tax, Canada in USD with tax.
- 96 categories and 40 collections.
- The `10OFF` promotion.
- A publishable key titled `k6 load test`.
- For each seller: a warehouse, a service zone covering all the regions'
  countries, and Standard and Express shipping options.

## Seeding

Run it on a fresh, migrated database, never on one with real data:

```bash
cd apps/api
createdb mercur_perf
DATABASE_URL=postgres://localhost/mercur_perf yarn medusa db:migrate
DATABASE_URL=postgres://localhost/mercur_perf yarn medusa exec ./src/scripts/perf/seed-marketplace.ts smoke
```

Replace `smoke` with `large` or `heavy`. The seed is resumable. If it stops,
run the same command again and it skips everything that already exists.

| Env var              | Default                       | Meaning                              |
| -------------------- | ----------------------------- | ------------------------------------ |
| `PERF_CONCURRENCY`   | 4                             | Workflows running in parallel        |
| `PERF_PRODUCT_BATCH` | 100                           | Products per create workflow         |
| `PERF_OFFER_BATCH`   | 1000                          | Offers per create workflow           |
| `PERF_PRODUCTS`      | preset                        | Override the product count           |
| `PERF_SELLERS`       | preset                        | Override the seller count            |
| `PERF_ENDPOINT`      | `https://mercur.medusajs.app` | Endpoint written to the fixtures     |

The seed writes `perf/fixtures/<preset>.json`. It holds the publishable key,
the region IDs, the promo code and the final counts. The IDs survive
`pg_dump`/`pg_restore`, so the k6 scripts read them from this file.

The seed creates everything through Mercur's workflows, so the data has the
same shape a real marketplace would. That makes it slow: time the `smoke` and
`large` runs before starting `heavy`. Measured on a laptop: `smoke` (200
products, 2.1k offers) took 12 seconds, about 70 products/s and 270 offers/s.
At that rate `large` takes roughly 45 minutes and `heavy` 8 hours or more.
Redis is not part of the dump.

## Moving the data to Medusa Cloud

Medusa Cloud runs Postgres 16 and rejects dumps from newer `pg_dump`
versions ("Version mismatch (1.16)"). Seed into a Postgres 16 server and dump
with `pg_dump` 16 (`brew install postgresql@16`, keg-only, at
`/opt/homebrew/opt/postgresql@16/bin`).

```bash
PGHOST=localhost PGPORT=5433 perf/export-dump.sh mercur_perf_large mercur_perf_large.dump
```

Then import the file from the Medusa Cloud dashboard. The import restores with
`--clean` over a database that already ran migrations. That fails on the Index
module's objects: the `cat_*` partitions under `index_data`, and the
`update_document_tsv()` trigger function. The script dumps a copy of the
database with those objects removed, and the target keeps its own Index tables.

**Rebuild the Index after every import.** Imported rows never reach the Index,
and `/store/offers` reads from it when the Index engine is enabled. Until the
rebuild it returns an empty list with status 200. Log in as the admin user the
seed created (`admin@mercur.dev`; the password is `PERF_ADMIN_PASSWORD` or the
one printed by the seed) and reset the Index:

```bash
TOKEN=$(curl -s -X POST "$ENDPOINT/auth/user/emailpass" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@mercur.dev\",\"password\":\"$PERF_ADMIN_PASSWORD\"}" | jq -r .token)
curl -X POST "$ENDPOINT/admin/index/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"strategy":"reset"}'
```

Wait for the sync to finish before running k6. Check it with
`GET /admin/index/details`.

To check a dump before uploading, restore it locally the way Cloud does:

```bash
createdb mercur_restore_test   # on the Postgres 16 server
DATABASE_URL=postgres://localhost:5433/mercur_restore_test yarn medusa db:migrate
pg_restore -d mercur_restore_test --clean --if-exists --no-owner --no-acl \
  --single-transaction --exit-on-error mercur_perf_large.dump
```

The Medusa Cloud deployment must run the same Mercur commit the seed ran on,
so the schema matches the dump.

## Running the tests

Follow Medusa Cloud's guidance:

1. **Instrument first.** Enable OpenTelemetry in `apps/api/instrumentation.ts`
   so each slow request can be traced to its workflow steps and queries.
2. **Start small.** Run about 20 VUs against the `smoke` or `large` data. Fix
   the obvious hot spots before scaling up.
3. **Ramp gradually.** Medusa's 2-minute ramp to the target VUs is what Cloud
   autoscaling can absorb. Jumping from 0 to full load needs the deployment to
   be pre-scaled, so arrange that with Medusa before any test that does it.
4. **Publish only full runs.** Use 420 VUs on Grafana Cloud k6 (2m ramp up,
   6m steady, 2m ramp down), from the load zone closest to the deployment.

## Server-side cache knobs

The store product routes cache the computed offer prices and the tax lines in
the Medusa caching module (`packages/core/src/api/utils/offers.ts`). Both are
on by default and can be switched off per deployment to produce the
"before cache" column of a run:

| Variable                       | Default | What                                            |
| ------------------------------ | ------- | ----------------------------------------------- |
| `MERCUR_STORE_PRICE_CACHE_TTL` | `60`    | Seconds for the offer-price map; `0` disables   |
| `MERCUR_STORE_TAX_CACHE_TTL`   | `300`   | Seconds for product tax lines; `0` disables     |
