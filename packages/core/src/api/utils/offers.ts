import {
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaResponse,
  MedusaStoreRequest,
} from "@medusajs/framework/http"
import {
  calculateAmountsWithTax,
  ContainerRegistrationKeys,
  Modules,
  useCache,
} from "@medusajs/framework/utils"
import type {
  ItemTaxLineDTO,
  MedusaContainer,
  MedusaPricingContext,
  TaxableItemDTO,
  TaxCalculationContext,
} from "@medusajs/framework/types"

const OFFER_WRAP_FIELDS = [
  "id",
  "seller_id",
  "variant_id",
  "shipping_profile_id",
  "sku",
  "ean",
  "upc",
  "created_at",
  "updated_at",
  "seller.id",
  "seller.name",
  "seller.handle",
  "shipping_profile.id",
  "shipping_profile.name",
  "prices.id",
  "prices.amount",
  "prices.currency_code",
  "prices.min_quantity",
  "prices.max_quantity",
  "inventory_item_link.id",
  "inventory_item_link.required_quantity",
  "inventory_item_link.inventory_item_id",
  "inventory_item_link.inventory_item.id",
  "inventory_item_link.inventory_item.sku",
  "inventory_item_link.inventory_item.title",
  "inventory_item_link.inventory_item.location_levels.id",
  "inventory_item_link.inventory_item.location_levels.location_id",
  "inventory_item_link.inventory_item.location_levels.stocked_quantity",
]

type WrappableVariant = { id: string; offers?: unknown[] }
type WrappableProduct = { variants?: WrappableVariant[] | null }
type OfferRow = { variant_id: string }

/**
 * The `offer ↔ variant` link is shared across sellers, so a raw graph
 * traversal would surface every seller's offers on a master variant.
 */
export const wrapProductVariantsWithOffers = async (
  scope: MedusaContainer,
  products: WrappableProduct[],
  sellerId?: string
): Promise<void> => {
  const variantIds = Array.from(
    new Set(products.flatMap((p) => (p.variants ?? []).map((v) => v.id)))
  )

  if (!variantIds.length) {
    return
  }

  const query = scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: offers } = await query.graph({
    entity: "offer",
    fields: OFFER_WRAP_FIELDS,
    filters: {
      variant_id: variantIds,
      ...(sellerId ? { seller_id: sellerId } : {}),
    },
  })

  const offersByVariant = new Map<string, unknown[]>()
  for (const offer of offers as OfferRow[]) {
    const existing = offersByVariant.get(offer.variant_id)
    if (existing) {
      existing.push(offer)
    } else {
      offersByVariant.set(offer.variant_id, [offer])
    }
  }

  for (const product of products) {
    for (const variant of product.variants ?? []) {
      variant.offers = offersByVariant.get(variant.id) ?? []
    }
  }
}

type OfferAwareRequest = AuthenticatedMedusaRequest & {
  seller_context?: { seller_id?: string }
}

export const applyOfferedProductsFilter = async (
  req: OfferAwareRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) => {
  req.filterableFields ??= {}
  const hasOffer = req.filterableFields.has_offer
  delete req.filterableFields.has_offer

  if (hasOffer !== true) {
    return next()
  }

  const contextSellerId = req.seller_context?.seller_id
  const sellerId =
    contextSellerId ?? (req.filterableFields.seller_id as string | string[] | undefined)
  if (!contextSellerId) {
    delete req.filterableFields.seller_id
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data: offers } = await query.graph({
    entity: "offer",
    fields: ["product_id"],
    filters: sellerId ? { seller_id: sellerId } : {},
  })

  const productIds = Array.from(
    new Set(
      offers
        .map((offer: { product_id: string | null }) => offer.product_id)
        .filter((id: string | null): id is string => Boolean(id))
    )
  )

  const existingAnd = (req.filterableFields.$and as object[] | undefined) ?? []
  req.filterableFields.$and = [
    ...existingAnd,
    { id: productIds.length ? productIds : ["__none__"] },
  ]

  return next()
}

const PRODUCT_FILTER_KEYS = ["q", "status", "collection_id", "type_id"] as const

// Cross-module link relations can't be filtered on the offer query, so
// product-attribute filters are resolved to a product_id set on the product
// entity first.
export const applyGroupedOfferProductFilter = async (
  req: OfferAwareRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction
) => {
  req.filterableFields ??= {}
  const fields = req.filterableFields as Record<string, unknown>

  if (fields.group_by_seller !== true) {
    return next()
  }

  const productFilters: Record<string, unknown> = {}
  for (const key of PRODUCT_FILTER_KEYS) {
    if (fields[key] !== undefined && fields[key] !== null) {
      productFilters[key] = fields[key]
      delete fields[key]
    }
  }
  if (fields.category_id !== undefined && fields.category_id !== null) {
    productFilters.categories = {
      id: Array.isArray(fields.category_id)
        ? fields.category_id
        : [fields.category_id],
    }
    delete fields.category_id
  }
  if (fields.tag_id !== undefined && fields.tag_id !== null) {
    productFilters.tags = {
      id: Array.isArray(fields.tag_id) ? fields.tag_id : [fields.tag_id],
    }
    delete fields.tag_id
  }

  if (!Object.keys(productFilters).length) {
    return next()
  }

  if (fields.product_id !== undefined && fields.product_id !== null) {
    productFilters.id = fields.product_id
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id"],
    filters: productFilters,
  })

  const productIds = products.map((product: { id: string }) => product.id)
  fields.product_id = productIds.length ? productIds : ["__none__"]

  return next()
}

type StoreRequestWithContext = MedusaStoreRequest<unknown> & {
  pricingContext?: MedusaPricingContext
  taxContext?: {
    taxLineContext?: TaxCalculationContext
    taxInclusivityContext?: { automaticTaxes: boolean }
  }
}

type OfferByVariantRow = { id: string; variant_id: string }

type PriceableVariant = {
  id: string
  offer_id?: string | null
  calculated_price?: Record<string, unknown> | null
  price_set?: { id?: string | null } | null
}

type PriceableProduct = {
  id?: string
  variants?: PriceableVariant[] | null
}

type CalculatedPriceRow = {
  id: string
  calculated_price?: { id?: string | null } | null
}

type OfferPriceHit = { offerId: string | null; price: Record<string, unknown> }

// Seconds; `0` disables. Price and tax writes clear the entries through their
// tags, the TTL bounds anything that reaches the cache without an event.
const readCacheTtl = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === "") {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const OFFER_PRICE_CACHE_TTL = readCacheTtl("MERCUR_STORE_PRICE_CACHE_TTL", 60)
const TAX_LINES_CACHE_TTL = readCacheTtl("MERCUR_STORE_TAX_CACHE_TTL", 300)

const OFFER_PRICE_CACHE_TAGS = [
  "Price:list:*",
  "PriceRule:list:*",
  "PriceSet:list:*",
  "PriceList:list:*",
  "PriceListRule:list:*",
  "Offer:list:*",
  "LinkOfferPrice:list:*",
]

const TAX_LINES_CACHE_TAGS = [
  "TaxRate:list:*",
  "TaxRateRule:list:*",
  "TaxRegion:list:*",
  "TaxProvider:list:*",
]

// The graph field that gives each variant its price set; requested only for
// priced reads and stripped from the response again.
export const VARIANT_PRICE_SET_FIELD = "variants.price_set.id"

export const withVariantPriceSetField = (fields: string[]): string[] =>
  fields.includes(VARIANT_PRICE_SET_FIELD)
    ? fields
    : [...fields, VARIANT_PRICE_SET_FIELD]

/**
 * Sets each variant's cheapest offer as `variant.offer_id` + its
 * `variant.calculated_price`, in place. Offer prices share the variant price
 * set scoped by an `offer_id` rule, so passing the union of offer ids as the
 * pricing context lets one batched `calculatePrices` return the lowest matching
 * price per price set; `offer_id` is recovered from the winning price row via
 * its `offer_id` price rule. Variants without an offer get `null` for both.
 * No-ops without a pricing context (caller did not request calculated prices).
 *
 * The variant's price set id must already be on the row
 * (`variants.price_set.id`, see `withVariantPriceSetField`): that keeps the
 * offer read a single-table lookup instead of a hop through variant and prices.
 */
export const wrapProductVariantsWithOfferPrice = async (
  req: StoreRequestWithContext,
  products: PriceableProduct[]
): Promise<void> => {
  if (!req.pricingContext) {
    return
  }

  const priceSetToVariant = new Map<string, string>()
  const variantIds: string[] = []
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      variantIds.push(variant.id)
      const priceSetId = variant.price_set?.id
      if (priceSetId) {
        priceSetToVariant.set(priceSetId, variant.id)
      }
      delete variant.price_set
    }
  }
  if (!variantIds.length) {
    return
  }

  const byVariant: Record<string, OfferPriceHit> = priceSetToVariant.size
    ? await useCache(
        () => calculateOfferPrices(req, variantIds, priceSetToVariant),
        {
          enable: OFFER_PRICE_CACHE_TTL > 0,
          key: [
            "mercur:store-offer-prices",
            Array.from(priceSetToVariant.entries()).sort(),
            req.pricingContext,
          ],
          tags: OFFER_PRICE_CACHE_TAGS,
          ttl: OFFER_PRICE_CACHE_TTL,
          container: req.scope,
        }
      )
    : {}

  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const hit = byVariant[variant.id]
      variant.offer_id = hit?.offerId ?? null
      variant.calculated_price = hit?.price ?? null
    }
  }

  await wrapVariantsWithTaxPrices(req, products)
}

// Returns a plain object: the result is cached, and a Map would not survive
// the JSON round trip.
const calculateOfferPrices = async (
  req: StoreRequestWithContext,
  variantIds: string[],
  priceSetToVariant: Map<string, string>
): Promise<Record<string, OfferPriceHit>> => {
  const byVariant: Record<string, OfferPriceHit> = {}

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: offers } = await query.graph({
    entity: "offer",
    fields: ["id", "variant_id"],
    filters: { variant_id: Array.from(new Set(variantIds)) },
  })
  if (!offers.length) {
    return byVariant
  }

  const offerIds = Array.from(
    new Set((offers as OfferByVariantRow[]).map((offer) => offer.id))
  )

  const context: Record<string, unknown> = {
    ...(req.pricingContext as Record<string, unknown>),
    offer_id: offerIds,
  }
  const pricingModule = req.scope.resolve(Modules.PRICING)
  const calculated = (await pricingModule.calculatePrices(
    { id: Array.from(priceSetToVariant.keys()) },
    { context: context as Record<string, string | number> }
  )) as unknown as CalculatedPriceRow[]

  const winningPriceIds = calculated
    .map((calc) => calc.calculated_price?.id)
    .filter((id): id is string => !!id)

  const offerByPriceId = new Map<string, string>()
  if (winningPriceIds.length) {
    const rules = await pricingModule.listPriceRules(
      { price_id: winningPriceIds, attribute: "offer_id" },
      { select: ["price_id", "value"] }
    )
    for (const rule of rules) {
      offerByPriceId.set(rule.price_id, rule.value)
    }
  }

  for (const calc of calculated) {
    const variantId = priceSetToVariant.get(calc.id)
    if (!variantId) {
      continue
    }
    const winningPriceId = calc.calculated_price?.id ?? null
    byVariant[variantId] = {
      offerId: winningPriceId
        ? offerByPriceId.get(winningPriceId) ?? null
        : null,
      price: calc as unknown as Record<string, unknown>,
    }
  }

  return byVariant
}

/**
 * Adds tax-inclusive / tax-exclusive amounts onto each variant's
 * `calculated_price`, gated on automatic taxes being enabled.
 */
const wrapVariantsWithTaxPrices = async (
  req: StoreRequestWithContext,
  products: PriceableProduct[]
): Promise<void> => {
  if (
    !req.taxContext?.taxInclusivityContext ||
    !req.taxContext?.taxLineContext ||
    !req.taxContext.taxInclusivityContext.automaticTaxes
  ) {
    return
  }

  const items: TaxableItemDTO[] = []
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const price = variant.calculated_price as
        | Record<string, unknown>
        | null
        | undefined
      if (!price || !product.id) {
        continue
      }
      items.push({
        id: variant.id,
        product_id: product.id,
        quantity: 1,
        unit_price: price.calculated_amount as number,
        currency_code: price.currency_code as string,
      } as TaxableItemDTO)
    }
  }
  if (!items.length) {
    return
  }

  // Rates depend on the product and the address, not on the amount, so the
  // key leaves `unit_price` out and one entry serves every price of a page.
  const taxLineContext = req.taxContext.taxLineContext
  const taxLines = await useCache(
    async () => {
      const taxService = req.scope.resolve(Modules.TAX)
      return (await taxService.getTaxLines(
        items,
        taxLineContext
      )) as unknown as ItemTaxLineDTO[]
    },
    {
      enable: TAX_LINES_CACHE_TTL > 0,
      key: [
        "mercur:store-tax-lines",
        taxLineContext.address,
        items.map((item) => [item.id, item.product_id, item.currency_code]),
      ],
      tags: TAX_LINES_CACHE_TAGS,
      ttl: TAX_LINES_CACHE_TTL,
      container: req.scope,
    }
  )

  const taxRatesMap = new Map<string, ItemTaxLineDTO[]>()
  for (const taxLine of taxLines) {
    const existing = taxRatesMap.get(taxLine.line_item_id) ?? []
    existing.push(taxLine)
    taxRatesMap.set(taxLine.line_item_id, existing)
  }

  for (const product of products) {
    for (const variant of product.variants ?? []) {
      const price = variant.calculated_price as Record<string, unknown> | null
      if (!price) {
        continue
      }

      const taxRatesForVariant = taxRatesMap.get(variant.id) || []

      const { priceWithTax, priceWithoutTax } = calculateAmountsWithTax({
        taxLines: taxRatesForVariant,
        amount: price.calculated_amount as number,
        includesTax: price.is_calculated_price_tax_inclusive as boolean,
      })
      price.calculated_amount_with_tax = priceWithTax
      price.calculated_amount_without_tax = priceWithoutTax

      const {
        priceWithTax: originalPriceWithTax,
        priceWithoutTax: originalPriceWithoutTax,
      } = calculateAmountsWithTax({
        taxLines: taxRatesForVariant,
        amount: price.original_amount as number,
        includesTax: price.is_original_price_tax_inclusive as boolean,
      })
      price.original_amount_with_tax = originalPriceWithTax
      price.original_amount_without_tax = originalPriceWithoutTax
    }
  }
}
