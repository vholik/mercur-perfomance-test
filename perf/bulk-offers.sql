-- Creates offers for every product that has none yet, directly in SQL, with
-- the same rows createOffersWorkflow writes: the offer, its product and
-- seller links, one inventory item with a stock level at the seller's
-- warehouse, an EUR and a USD price in the variant's price set scoped to the
-- offer by rule, and the price links. The workflow manages about 12 offers a
-- second; this does millions in minutes, for the heavy preset.
--
--   psql -d mercur_perf_heavy -v ON_ERROR_STOP=1 -f perf/bulk-offers.sql
--   psql ... -v product_limit=1000 -f perf/bulk-offers.sql   # a sample first
--
-- Sellers per product follow the seed's distribution (1 to 20, about 3.4 on
-- average) from a hash of the product id, so reruns are deterministic and
-- skip products that already have offers. Nothing here emits events: the
-- Index engine rebuilds from scratch on the next server boot.
\if :{?product_limit}
\else
\set product_limit 2147483647
\endif

SET synchronous_commit = off;
SET work_mem = '512MB';
SET maintenance_work_mem = '1GB';

BEGIN;

-- Ids sort in the order rows are inserted, so every index grows at its
-- right edge instead of taking millions of random-page writes. Still 26
-- upper-case characters like a ULID.
-- The high bits carry the run's start time, so a rerun never collides with
-- ids an earlier run of this script minted.
CREATE TEMP TABLE run_base AS
SELECT (extract(epoch FROM now())::bigint - 1700000000) << 24 AS n;

CREATE OR REPLACE FUNCTION pg_temp.oid(n bigint, salt text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT upper(lpad(to_hex(n + (SELECT n FROM run_base)), 13, '0') || substr(md5(salt || n::text), 1, 13))
$$;

-- 0..1 from a text hash, stable across runs.
CREATE OR REPLACE FUNCTION pg_temp.frac(t text) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT (hashtext(t) & 2147483647)::double precision / 2147483647
$$;

CREATE TEMP TABLE sellers_idx AS
SELECT s.id AS seller_id,
       row_number() OVER (ORDER BY s.id) AS seller_idx,
       sl.stock_location_id,
       sm.member_id
FROM seller s
JOIN stock_location_stock_location_seller_seller sl
  ON sl.seller_id = s.id AND sl.deleted_at IS NULL
JOIN seller_member sm
  ON sm.seller_id = s.id AND sm.deleted_at IS NULL AND sm.is_owner
WHERE s.deleted_at IS NULL;
CREATE INDEX ON sellers_idx (seller_idx);

CREATE TEMP TABLE products_todo AS
SELECT p.id AS product_id
FROM product p
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM offer o WHERE o.product_id = p.id)
ORDER BY p.id
LIMIT :product_limit;

-- Seller count per product: 1 + an exponential tail with mean 2.85, capped
-- at 20, like the seed. Seller picks are hashed per product and slot.
CREATE TEMP TABLE pairs AS
WITH k AS (
  SELECT product_id,
         least(20, 1 + floor(-ln(1 - pg_temp.frac(product_id || ':k') * 0.999) * 2.85))::int AS n
  FROM products_todo
),
picks AS (
  SELECT k.product_id,
         1 + floor(pg_temp.frac(k.product_id || ':' || g) * (SELECT count(*) FROM sellers_idx))::int AS seller_idx
  FROM k, generate_series(1, k.n) AS g
)
SELECT DISTINCT p.product_id, si.seller_id, si.seller_idx, si.stock_location_id, si.member_id
FROM picks p
JOIN sellers_idx si USING (seller_idx);
CREATE INDEX ON pairs (product_id);

-- One row per offer to create, with every id minted up front.
CREATE TEMP TABLE new_offers AS
SELECT rn,
       'offer_' || pg_temp.oid(rn, 'offer')      AS offer_id,
       'iitem_' || pg_temp.oid(rn, 'iitem')      AS iitem_id,
       'ilev_'  || pg_temp.oid(rn, 'ilev')       AS ilev_id,
       'price_' || pg_temp.oid(2 * rn, 'price')  AS price_eur_id,
       'price_' || pg_temp.oid(2 * rn + 1, 'price') AS price_usd_id,
       product_id, seller_id, stock_location_id, member_id, variant_id, variant_title,
       sku, price_set_id, eur, shipping_profile_id
FROM (
SELECT row_number() OVER (ORDER BY pr.product_id, pr.seller_id, v.id) AS rn,
       pr.product_id,
       pr.seller_id,
       pr.stock_location_id,
       pr.member_id,
       v.id  AS variant_id,
       v.title AS variant_title,
       'S' || pr.seller_idx || '-' || v.sku AS sku,
       pvps.price_set_id,
       -- 5 to 344 EUR like the seed, varied per seller by up to 30%.
       greatest(1, round((5 + pg_temp.frac(pr.product_id || ':price') * 339)
                         * (0.85 + pg_temp.frac(pr.product_id || ':' || pr.seller_id) * 0.3)))::bigint AS eur,
       sp.id AS shipping_profile_id
FROM pairs pr
JOIN product_variant v ON v.product_id = pr.product_id AND v.deleted_at IS NULL
JOIN product_variant_price_set pvps ON pvps.variant_id = v.id AND pvps.deleted_at IS NULL
CROSS JOIN (SELECT id FROM shipping_profile WHERE name = 'Marketplace Shipping' LIMIT 1) sp
) o;
CREATE INDEX ON new_offers (rn);

\echo offers to create:
SELECT count(*) FROM new_offers;

INSERT INTO inventory_item (id, created_at, updated_at, sku, requires_shipping, title)
SELECT iitem_id, now(), now(), sku, true, variant_title FROM new_offers ORDER BY rn;

INSERT INTO inventory_level (id, created_at, updated_at, inventory_item_id, location_id,
  stocked_quantity, reserved_quantity, incoming_quantity,
  raw_stocked_quantity, raw_reserved_quantity, raw_incoming_quantity)
SELECT ilev_id, now(), now(), iitem_id, stock_location_id,
  1000000, 0, 0,
  '{"value": "1000000", "precision": 20}', '{"value": "0", "precision": 20}', '{"value": "0", "precision": 20}'
FROM new_offers ORDER BY rn;

INSERT INTO inventory_inventory_item_seller_seller (id, inventory_item_id, seller_id, created_at, updated_at)
SELECT 'link_' || pg_temp.oid(rn, 'iis'), iitem_id, seller_id, now(), now() FROM new_offers ORDER BY rn;

INSERT INTO offer (id, seller_id, variant_id, shipping_profile_id, sku, created_by, created_at, updated_at,
  product_id, manage_inventory, allow_backorder)
SELECT offer_id, seller_id, variant_id, shipping_profile_id, sku, member_id, now(), now(),
  product_id, true, false
FROM new_offers ORDER BY rn;

INSERT INTO offer_product (id, offer_id, product_id, created_at, updated_at)
SELECT 'link_' || pg_temp.oid(rn, 'op'), offer_id, product_id, now(), now() FROM new_offers ORDER BY rn;

INSERT INTO offer_seller (id, offer_id, seller_id, created_at, updated_at)
SELECT 'link_' || pg_temp.oid(rn, 'os'), offer_id, seller_id, now(), now() FROM new_offers ORDER BY rn;

INSERT INTO offer_inventory_item (id, offer_id, inventory_item_id, required_quantity, created_at, updated_at)
SELECT 'link_' || pg_temp.oid(rn, 'oi'), offer_id, iitem_id, 1, now(), now() FROM new_offers ORDER BY rn;

INSERT INTO price (id, price_set_id, currency_code, amount, raw_amount, rules_count, created_at, updated_at)
SELECT price_eur_id, price_set_id, 'eur', eur,
  json_build_object('value', eur::text, 'precision', 20)::jsonb, 1, now(), now()
FROM new_offers
UNION ALL
SELECT price_usd_id, price_set_id, 'usd', round(eur * 1.08),
  json_build_object('value', round(eur * 1.08)::text, 'precision', 20)::jsonb, 1, now(), now()
FROM new_offers
ORDER BY 1;

INSERT INTO price_rule (id, price_id, attribute, operator, value, priority, created_at, updated_at)
SELECT 'prule_' || pg_temp.oid(2 * rn, 'prule'), price_eur_id, 'offer_id', 'eq', offer_id, 0, now(), now() FROM new_offers
UNION ALL
SELECT 'prule_' || pg_temp.oid(2 * rn + 1, 'prule'), price_usd_id, 'offer_id', 'eq', offer_id, 0, now(), now() FROM new_offers
ORDER BY 1;

INSERT INTO offer_offer_pricing_price (id, offer_id, price_id, created_at, updated_at)
SELECT 'link_' || pg_temp.oid(2 * rn, 'opp'), offer_id, price_eur_id, now(), now() FROM new_offers
UNION ALL
SELECT 'link_' || pg_temp.oid(2 * rn + 1, 'opp'), offer_id, price_usd_id, now(), now() FROM new_offers
ORDER BY 1;

COMMIT;

\echo totals:
SELECT (SELECT count(*) FROM offer) AS offers,
       (SELECT count(*) FROM price) AS prices,
       (SELECT count(*) FROM inventory_level) AS levels;
