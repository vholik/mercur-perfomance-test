import {
  MedusaResponse,
  MedusaStoreRequest,
} from "@medusajs/framework/http"
import {
  enrichProductAttributes,
  listProducts,
  withVariantPriceSetField,
  wrapProductVariantsWithOfferPrice,
} from "../../utils"
import {
  splitComputedVariantFields,
  stripPricingContextFilters,
} from "./helpers"

export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  // `variants.calculated_price` / `variants.offer_id` are computed from the
  // cheapest offer post-query, not graph columns — strip them before the read.
  const { fields, withCalculatedPrice } = splitComputedVariantFields(
    req.queryConfig.fields
  )
  req.queryConfig.fields = withCalculatedPrice
    ? withVariantPriceSetField(fields)
    : fields

  const productFilters = stripPricingContextFilters(
    req.filterableFields as Record<string, unknown> | undefined
  )

  const { products, count, estimate_count, offset, limit } = await listProducts(
    req.scope,
    {
      fields: req.queryConfig.fields,
      filters: productFilters,
      pagination: req.queryConfig.pagination,
      locale: req.locale,
      cache: { ttl: 300 },
    }
  )

  await enrichProductAttributes(req.scope, products as any[])

  if (withCalculatedPrice) {
    await wrapProductVariantsWithOfferPrice(req, products as any[])
  }

  res.json({ products, count, estimate_count, offset, limit })
}
