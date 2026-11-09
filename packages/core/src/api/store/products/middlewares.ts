import {
  applyDefaultFilters,
  applyParamsAsFilters,
  authenticate,
  maybeApplyLinkFilter,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
  MedusaStoreRequest,
  MiddlewareRoute,
  refetchEntities,
  refetchEntity,
} from "@medusajs/framework/http"
import { isPresent, MedusaError } from "@medusajs/framework/utils"
import type { MedusaPricingContext } from "@medusajs/framework/types"
import { validateAndTransformQuery } from "@medusajs/framework"
import {
  normalizeDataForContext,
  transformAndValidateSalesChannelIds,
} from "@medusajs/medusa/api/utils/middlewares/index"

import { canUseProductIndex, toProductIndexFilters } from "../../utils"
import { stripPricingContextFilters } from "./helpers"
import { storeProductQueryConfig } from "./query-config"
import {
  StoreGetProductParams,
  StoreGetProductsParams,
} from "./validators"
import { ProductStatus } from "@mercurjs/types"

const PRICE_FIELD_PATH = "variants.calculated_price"

/**
 * Apply the store-facing defaults that vanilla Medusa applies on its own
 * `/store/products` route. Besides forcing the `published` status, this
 * translates the Medusa-standard `category_id` query param into the
 * `categories` relation filter. The `Product` entity has no `category_id`
 * column, so passing it straight to `query.graph` raises
 * `Trying to query by not existing property Product.category_id` (#974).
 */
const applyProductFilters = applyDefaultFilters({
  status: ProductStatus.PUBLISHED,
  categories: (filters: Record<string, unknown>) => {
    const categoryIds = filters.category_id
    delete filters.category_id

    if (!isPresent(categoryIds)) {
      return
    }

    return { id: categoryIds, is_internal: false, is_active: true }
  },
})

/**
 * Translate global product-attribute filters (`attributes[<handle>]=v1,v2`)
 * into native variant-option filters. Every filterable global attribute is a
 * variant axis backed by a Medusa `ProductOption`, so its selected values live
 * on `variants.options.value`. Each attribute becomes its own `$and` clause
 * (AND across attributes), while multiple values within one attribute are OR'd.
 */
function transformAttributeFilters(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) {
  const filters = (req.filterableFields ??= {}) as Record<string, unknown>
  const attributes = filters.attributes as
    | Record<string, string | string[]>
    | undefined
  delete filters.attributes

  if (!attributes) {
    return next()
  }

  const clauses = Object.values(attributes)
    .map((value) =>
      (Array.isArray(value) ? value : String(value).split(","))
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
    .filter((values) => values.length > 0)
    .map((values) => ({ variants: { options: { value: values } } }))

  if (clauses.length > 0) {
    const existing = Array.isArray(filters.$and)
      ? (filters.$and as unknown[])
      : []
    filters.$and = [...existing, ...clauses]
  }

  next()
}

const applySalesChannelLinkFilter = maybeApplyLinkFilter({
  entryPoint: "product_sales_channel",
  resourceId: "product_id",
  filterableField: "sales_channel_id",
})

/**
 * Honor an explicit `sales_channel_id` filter, validated against the
 * publishable key as vanilla `/store/products` does. Unlike Medusa the key's
 * channels are not applied implicitly: vendor-created products are not attached
 * to a channel on their own, so an implicit scope would hide them from every
 * multi-channel marketplace.
 *
 * `sales_channel_id` is not a product column. When the list can be served by
 * the Index engine it stays on the request and `listProducts` turns it into the
 * indexed `sales_channels.id` filter; otherwise, and always on the detail
 * route, it is resolved to a product id set through the
 * `product_sales_channel` link.
 */
const applySalesChannelFilter =
  ({ allowIndex }: { allowIndex: boolean }) =>
  async (
    req: MedusaStoreRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) => {
    const filters = (req.filterableFields ??= {}) as Record<string, unknown>

    if (!isPresent(req.validatedQuery.sales_channel_id)) {
      delete filters.sales_channel_id
      return next()
    }
    filters.sales_channel_id = transformAndValidateSalesChannelIds(req)

    if (
      allowIndex &&
      canUseProductIndex(
        req.scope,
        toProductIndexFilters(stripPricingContextFilters(filters)),
        req.queryConfig?.pagination
      )
    ) {
      return next()
    }

    return applySalesChannelLinkFilter(req, res, next)
  }

type PricedStoreRequest = MedusaStoreRequest & {
  pricingContext?: MedusaPricingContext
  taxContext?: {
    taxLineContext?: {
      address: { country_code: string; province_code?: string }
      locale?: string
    }
    taxInclusivityContext?: { automaticTaxes: boolean }
  }
}

/**
 * One cached region read for both the pricing and the tax context the
 * offer-price wrap consumes. Mirrors Medusa's `setPricingContext` +
 * `setTaxContext` pair, which reads the region twice (the second time without
 * the cache). Prices compute only when the client requests
 * `variants.calculated_price` or passes `region_id` (see
 * `normalizeDataForContext`).
 */
async function setOfferPricingContext(
  req: PricedStoreRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) {
  const withCalculatedPrice = req.queryConfig.fields.some(
    (field) =>
      field === PRICE_FIELD_PATH || field.startsWith(`${PRICE_FIELD_PATH}.`)
  )
  if (!withCalculatedPrice) {
    return next()
  }

  const filters = req.filterableFields as Record<string, unknown>
  const regionId = filters.region_id as string | undefined
  if (!regionId) {
    return next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing required pricing context to calculate prices - region_id"
      )
    )
  }

  const region = (await refetchEntity({
    entity: "region",
    idOrFilter: regionId,
    scope: req.scope,
    fields: ["id", "currency_code", "automatic_taxes"],
    options: { cache: { enable: true } },
  })) as
    | { id: string; currency_code: string; automatic_taxes: boolean }
    | undefined

  if (!region) {
    return next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Region with id ${regionId} not found when populating the pricing context`
      )
    )
  }

  const pricingContext: MedusaPricingContext = {
    region_id: region.id,
    currency_code: region.currency_code,
  }

  if (req.auth_context?.actor_id) {
    const { data: customerGroups } = await refetchEntities({
      entity: "customer_group",
      idOrFilter: { customers: { id: req.auth_context.actor_id } },
      scope: req.scope,
      fields: ["id"],
    })
    pricingContext.customer = {
      groups: (customerGroups as { id: string }[]).map((group) => ({
        id: group.id,
      })),
    }
  }

  req.pricingContext = pricingContext

  if (region.automatic_taxes) {
    const countryCode = filters.country_code as string | undefined
    req.taxContext = {
      taxInclusivityContext: { automaticTaxes: true },
      taxLineContext: countryCode
        ? {
            address: {
              country_code: countryCode,
              province_code: filters.province as string | undefined,
            },
            locale: req.locale,
          }
        : undefined,
    }
  }

  return next()
}

const pricingMiddlewares = [
  authenticate("customer", ["session", "bearer"], {
    allowUnauthenticated: true,
  }),
  normalizeDataForContext({ priceFieldPaths: [PRICE_FIELD_PATH] }),
  setOfferPricingContext,
]

export const storeProductsMiddlewares: MiddlewareRoute[] = [
  {
    method: ["GET"],
    matcher: "/store/products",
    middlewares: [
      validateAndTransformQuery(
        StoreGetProductsParams,
        storeProductQueryConfig.list
      ),
      applyProductFilters,
      transformAttributeFilters,
      applySalesChannelFilter({ allowIndex: true }),
      ...pricingMiddlewares,
    ],
  },
  {
    method: ["GET"],
    matcher: "/store/products/:id",
    middlewares: [
      validateAndTransformQuery(
        StoreGetProductParams,
        storeProductQueryConfig.retrieve
      ),
      applyParamsAsFilters({ id: "id" }),
      applyProductFilters,
      applySalesChannelFilter({ allowIndex: false }),
      ...pricingMiddlewares,
    ],
  },
]
