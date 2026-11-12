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
same shape a real marketplace would. That makes it slow, and the offer step
slows down as the price and link tables grow. Measured on a laptop: `smoke`
(200 products, 2.1k offers) took 12 seconds; `large` took 12 hours, of which
products were 8 minutes (about 106/s) and offers the rest (about 12/s). At
that rate `heavy` would take days, so it needs a bulk-insert path for offers
before it is worth starting. Redis is not part of the dump.

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

### Shipping the Index with the dump

`/store/offers` reads from the Index module when the Index engine is enabled,
and the seed never builds it (`medusa exec` runs no sync). Building it on
Cloud by `POST /admin/index/sync` is far too slow for the large dataset: the
Offer entity advanced about 1,500 rows an hour there, nine days for 508k
offers, while a local server synced all nine entities in under six minutes.
So build it locally and ship it inside the dump:

```bash
cd apps/api
PORT=9100 REDIS_URL=redis://localhost:6379/5 \
  DATABASE_URL=postgres://localhost:5433/mercur_perf_large yarn medusa develop
# wait for "[Index engine] syncing entity '...' done" for every entity,
# or poll GET /admin/index/details until all are "done", then stop the server
PGHOST=localhost PGPORT=5433 KEEP_INDEX=1 \
  perf/export-dump.sh mercur_perf_large mercur_perf_large_indexed.dump
```

`KEEP_INDEX=1` keeps the four `index_*` tables. The restore's `--clean` fails
on a partition's inherited primary-key or unique constraint, so the export
copy swaps those three constraints on `index_data` and `index_relation` for
unique indexes of the same columns. The module's upserts only need the unique
`(id, name)`, and pg_dump emits no drop for an index partition. The result
restores with Cloud's flags into a database whose server already created the
partitions, verified locally; the Index engine then reports zero pending
changes on boot.

Right after an import the Index tables have no planner statistics, so the
store's `count` (a `count_estimate` over the query plan) is wrong until
autovacuum analyzes them, a few minutes at most. Run nothing against the
import until `GET /store/offers` reports the full count.

**Without the Index in the dump, rebuild it after every import.** Until then
`/store/offers` returns an empty list with status 200. Log in as the admin user
the seed created (`admin@mercur.dev`; the password is `PERF_ADMIN_PASSWORD` or
the one printed by the seed) and reset the Index:

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

The product listing reads page one, as Medusa's script does. `RANDOM_PAGE=1`
spreads the listing over the whole catalog instead, which defeats the list
cache and measures the cold cost of the Index query; keep it out of runs that
are compared with Medusa's numbers.

### Vendor and admin scenarios

Medusa's script only covers the storefront. Mercur has two more surfaces, so
the script adds two scenarios that run next to the storefront ones:

| Scenario      | VUs at full scale | What it does                                                                                   |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `vendorPanel` | 30                | Logs in as a seed seller (one per VU), selects the store, then reads orders, products, offers, inventory and payouts, with one detail page each |
| `adminPanel`  | 10                | Reads orders, order groups, sellers, products, offers grouped by seller, the product-change inbox and payouts, with one detail page each |

The seller password is the seed's (`supersecret`, override with
`SELLER_PASSWORD`). The admin scenario needs `ADMIN_EMAIL` and
`ADMIN_PASSWORD` and is skipped without them. `STORE_ONLY=1` runs the
storefront scenarios alone, for a run that matches Medusa's profile exactly.
Both panel scenarios have a p95 threshold of 700 ms.

```bash
DATASET=large SCALE=0.05 ADMIN_EMAIL=admin@mercur.dev ADMIN_PASSWORD=... \
  k6 run perf/k6/mercur-marketplace.js
```

### Running from the deployment's region

Medusa Cloud runs `mercur.medusajs.app` in AWS eu-central-1 (its CNAME is
`t1-aws-euc1-cdn.medusajs.app`). Runs from a laptop add about 40 ms of
network per request, so the published runs come from an EC2 instance in that
region. `perf/ec2/` holds the scripts:

```bash
perf/ec2/launch.sh            # c6i.xlarge, Ubuntu 24.04, k6 installed on boot
ssh ubuntu@$(cat perf/ec2/.instance-ip)
echo '<admin password>' > ~/.perf-admin-password
mercur/perf/ec2/run.sh large-420vu-euc1 1      # runs in tmux; label, SCALE
tmux attach -t large-420vu-euc1
perf/ec2/terminate.sh         # when done
```

`launch.sh` needs AWS credentials with EC2 and SSM read access. It imports
`~/.ssh/id_ed25519.pub` as the key pair and opens port 22 to the launching
machine's IP only. Copy results back with `scp` into `perf/results/`.

Keep the script's 2-minute ramp. Cloud autoscaling takes one to two minutes
to add pods, so a run that jumps straight to full load needs the deployment
pre-scaled by Medusa first.

## Server-side cache knobs

The store product routes cache the computed offer prices and the tax lines in
the Medusa caching module (`packages/core/src/api/utils/offers.ts`). Both are
on by default and can be switched off per deployment to produce the
"before cache" column of a run:

| Variable                       | Default | What                                            |
| ------------------------------ | ------- | ----------------------------------------------- |
| `MERCUR_STORE_PRICE_CACHE_TTL` | `60`    | Seconds for the offer-price map; `0` disables   |
| `MERCUR_STORE_TAX_CACHE_TTL`   | `300`   | Seconds for product tax lines; `0` disables     |
