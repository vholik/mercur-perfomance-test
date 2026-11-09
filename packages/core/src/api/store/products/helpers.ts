/**
 * Splits the virtual offer-pricing fields (`variants.calculated_price[.*]`,
 * `variants.offer_id`) out of a store-product field set. They are computed
 * post-query from the cheapest offer, not graph columns, so passing them to
 * `query.graph` raises `Trying to query by not existing property`.
 */
export const splitComputedVariantFields = (fields: string[]) => {
  const withCalculatedPrice = fields.some(
    (f) =>
      f === "variants.calculated_price" ||
      f.startsWith("variants.calculated_price.") ||
      f === "variants.offer_id"
  )

  const filteredFields = fields.filter(
    (f) =>
      f !== "variants.calculated_price" &&
      !f.startsWith("variants.calculated_price.") &&
      f !== "variants.offer_id"
  )

  return { fields: filteredFields, withCalculatedPrice }
}

// Consumed by the pricing/tax context middlewares, not product columns:
// query.graph errors on them and the index rejects every non-indexed key.
const PRICING_CONTEXT_FILTER_KEYS = [
  "region_id",
  "currency_code",
  "country_code",
  "province",
  "cart_id",
]

export const stripPricingContextFilters = (
  filters: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const rest = { ...(filters ?? {}) }
  for (const key of PRICING_CONTEXT_FILTER_KEYS) {
    delete rest[key]
  }
  return rest
}
