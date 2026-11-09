import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { ExecArgs, MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  createApiKeysWorkflow,
  createCollectionsWorkflow,
  createLocationFulfillmentSetWorkflow,
  createProductCategoriesWorkflow,
  createPromotionsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createServiceZonesWorkflow,
  createShippingProfilesWorkflow,
  createTaxRegionsWorkflow,
  createUserAccountWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresStep,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  AttributeType,
  ProductStatus,
  type CreateOfferDTO,
  type CreateProductDTO,
} from "@mercurjs/types"
import {
  approveSellerWorkflow,
  createOffersWorkflow,
  createProductAttributesWorkflow,
  createProductsWorkflow,
  createSellerAccountWorkflow,
  createSellerShippingOptionsWorkflow,
  createSellerStockLocationsWorkflow,
} from "@mercurjs/core/workflows"

/**
 * Seeds a marketplace sized for the k6 load tests in /perf.
 *
 *   medusa exec ./src/scripts/perf/seed-marketplace.ts smoke|large|heavy
 *
 * Every entity is derived from its index, so the seed is deterministic and
 * resumable: re-running it skips what already exists and fills the gaps.
 * Run it against a fresh, migrated database, then dump that database.
 */

type Preset = { products: number; sellers: number }

const PRESETS: Record<string, Preset> = {
  smoke: { products: 200, sellers: 10 },
  large: { products: 50_000, sellers: 500 },
  heavy: { products: 500_000, sellers: 2_000 },
}

const CONCURRENCY = Number(process.env.PERF_CONCURRENCY || 4)
const PRODUCT_BATCH = Number(process.env.PERF_PRODUCT_BATCH || 100)
const OFFER_BATCH = Number(process.env.PERF_OFFER_BATCH || 1000)
const LOOKUP_BATCH = 500
const ENDPOINT = process.env.PERF_ENDPOINT || "https://mercur.medusajs.app"

const SELLER_PASSWORD = "supersecret"
const ADMIN_EMAIL = process.env.PERF_ADMIN_EMAIL || "admin@mercur.dev"
const API_KEY_TITLE = "k6 load test"
const SHIPPING_PROFILE_NAME = "Marketplace Shipping"
const PROMO_CODE = "10OFF"
const STOCK_PER_OFFER = 1_000_000

// Mean of the extra sellers per product drawn from an exponential, tuned so a
// product averages ~3.4 sellers and, at ~3 variants each, ~10 offers.
const EXTRA_SELLERS_MEAN = 2.85
const MAX_SELLERS_PER_PRODUCT = 20

const REGIONS = [
  { name: "Europe", currency_code: "eur", countries: ["de", "fr", "nl", "es", "it"], tax_rate: 20 },
  { name: "Nordics", currency_code: "eur", countries: ["dk", "se", "fi"], tax_rate: 25 },
  { name: "United States", currency_code: "usd", countries: ["us"], tax_rate: null },
  { name: "Canada", currency_code: "usd", countries: ["ca"], tax_rate: 13 },
]
const ALL_COUNTRIES = REGIONS.flatMap((r) => r.countries)
const SELLER_COUNTRIES = ["DE", "FR", "NL", "ES", "IT", "DK", "SE", "US"]

const SIZES = ["XS", "S", "M", "L", "XL", "XXL"]
const COLORS = [
  "Black", "White", "Grey", "Brown", "Beige", "Green",
  "Blue", "Red", "Yellow", "Orange", "Purple", "Pink",
]

const CATEGORY_PARENTS = [
  "Footwear", "Apparel", "Accessories", "Home", "Kitchen", "Garden",
  "Electronics", "Toys", "Sports", "Beauty", "Books", "Pets",
]
const CATEGORY_SUFFIXES = [
  "Essentials", "Premium", "Outlet", "New In", "Classics", "Kids", "Eco", "Limited",
]
const COLLECTION_TITLES = ["Spring", "Summer", "Autumn", "Winter"].flatMap(
  (season) =>
    ["Edit", "Drop", "Capsule", "Classics", "Sale"].flatMap((kind) =>
      ["2025", "2026"].map((year) => `${season} ${kind} ${year}`)
    )
)

const BRANDS = [
  "Northwind", "Bluepeak", "Ironleaf", "Saltmoor", "Kestrel", "Juniper",
  "Copperline", "Halden", "Marlow", "Odessa", "Quillon", "Ravel",
  "Solvik", "Tamsin", "Umbra", "Vantor", "Wexley", "Yarrow",
]
const ADJECTIVES = [
  "Classic", "Urban", "Everyday", "Trail", "Studio", "Coastal", "Heritage",
  "Lightweight", "Thermal", "Waterproof", "Organic", "Slim", "Relaxed",
  "Vintage", "Modern", "Rugged", "Compact", "Deluxe",
]
const NOUNS = [
  "Sneaker", "Jacket", "Hoodie", "Backpack", "Tote", "Lamp", "Mug",
  "Planter", "Headphones", "Speaker", "Yoga Mat", "Water Bottle", "Scarf",
  "Beanie", "Wallet", "Notebook", "Blanket", "Cushion", "Kettle", "Leash",
]
const SELLER_WORDS_A = [
  "Corner", "Harbor", "Summit", "Maple", "Atlas", "Velvet", "Granite",
  "Lantern", "Meadow", "Pioneer", "Quarry", "Riverside", "Sterling",
]
const SELLER_WORDS_B = [
  "Goods", "Supply", "Trading", "Outfitters", "Store", "Market",
  "Collective", "House", "Depot", "Works",
]

const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)]

const pad = (n: number, width: number) => String(n).padStart(width, "0")

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

const runPool = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
) => {
  let next = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++]
        await worker(item)
      }
    }
  )
  await Promise.all(runners)
}

const progress = (label: string, total: number, log: (msg: string) => void) => {
  const startedAt = Date.now()
  let done = 0
  let lastLog = 0
  return (n: number) => {
    done += n
    const now = Date.now()
    if (now - lastLog < 10_000 && done < total) {
      return
    }
    lastLog = now
    const elapsed = (now - startedAt) / 1000
    const rate = done / Math.max(elapsed, 1)
    const eta = rate > 0 ? Math.round((total - done) / rate) : 0
    log(
      `${label}: ${done}/${total} (${rate.toFixed(1)}/s, eta ${Math.floor(eta / 60)}m${eta % 60}s)`
    )
  }
}

type ProductSpec = {
  index: number
  title: string
  handle: string
  sizes: string[]
  color: string
  basePrice: number
}

const productSpec = (index: number): ProductSpec => {
  const rand = mulberry32(index * 7919 + 17)
  const title = `${pick(rand, BRANDS)} ${pick(rand, ADJECTIVES)} ${pick(rand, NOUNS)}`
  const variantCount = 1 + Math.floor(rand() * 5)
  const start = Math.floor(rand() * (SIZES.length - variantCount + 1))
  return {
    index,
    title,
    handle: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`,
    sizes: SIZES.slice(start, start + variantCount),
    color: pick(rand, COLORS),
    basePrice: 10 + Math.floor(rand() * 290),
  }
}

const sellersForProduct = (index: number, sellerCount: number): number[] => {
  const rand = mulberry32(index * 104729 + 3)
  const wanted = Math.min(
    sellerCount,
    MAX_SELLERS_PER_PRODUCT,
    1 + Math.floor(-Math.log(1 - rand()) * EXTRA_SELLERS_MEAN)
  )
  const picked = new Set<number>()
  while (picked.size < wanted) {
    picked.add(Math.floor(rand() * sellerCount))
  }
  return Array.from(picked)
}

const sellerSpec = (index: number) => {
  const rand = mulberry32(index * 31337 + 11)
  const name = `${pick(rand, SELLER_WORDS_A)} ${pick(rand, SELLER_WORDS_B)} ${pad(index + 1, 4)}`
  return {
    index,
    name,
    email: `perf-seller-${pad(index + 1, 4)}@mercur.dev`,
    country_code: SELLER_COUNTRIES[index % SELLER_COUNTRIES.length],
    standardOptionName: `${name} Standard`,
  }
}

const updateStoreCurrencies = createWorkflow(
  "perf-update-store-currencies",
  (input: {
    store_id: string
    supported_currencies: { currency_code: string; is_default?: boolean }[]
  }) => {
    const update = transform({ input }, (data) => ({
      selector: { id: data.input.store_id },
      update: { supported_currencies: data.input.supported_currencies },
    }))
    return new WorkflowResponse(updateStoresStep(update))
  }
)

type SetupResult = {
  salesChannelId: string
  publishableKey: string
  regions: { id: string; name: string; currency_code: string; countries: string[] }[]
  shippingProfileId: string
  categoryIds: string[]
  collectionIds: string[]
  sizeAttr: SeededAttribute
  colorAttr: SeededAttribute
}

type SeededAttribute = {
  id: string
  handle: string
  values: { id: string; name: string }[]
}

type SeededSeller = {
  id: string
  memberId: string
  stockLocationId: string
}

async function setup(container: MedusaContainer): Promise<SetupResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const storeModule = container.resolve(Modules.STORE)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
  const regionModule = container.resolve(Modules.REGION)
  const taxModule = container.resolve(Modules.TAX)
  const productModule = container.resolve(Modules.PRODUCT)
  const promotionModule = container.resolve(Modules.PROMOTION)

  const [store] = await storeModule.listStores()

  let [salesChannel] = await salesChannelModule.listSalesChannels({
    name: "Default Sales Channel",
  })
  if (!salesChannel) {
    const { result } = await createSalesChannelsWorkflow(container).run({
      input: { salesChannelsData: [{ name: "Default Sales Channel" }] },
    })
    salesChannel = result[0]
  }

  await updateStoreCurrencies(container).run({
    input: {
      store_id: store.id,
      supported_currencies: [
        { currency_code: "eur", is_default: true },
        { currency_code: "usd" },
      ],
    },
  })

  logger.info("Seeding regions and tax regions...")
  const existingRegions = await regionModule.listRegions(
    {},
    { relations: ["countries"] }
  )
  const regionByName = new Map(existingRegions.map((r) => [r.name, r]))
  const countryOwner = new Map<string, string>()
  for (const region of existingRegions) {
    for (const country of region.countries ?? []) {
      countryOwner.set(country.iso_2, region.name)
    }
  }

  const missingRegions = REGIONS.filter((r) => !regionByName.has(r.name))
  for (const region of missingRegions) {
    const taken = region.countries.find((c) => countryOwner.has(c))
    if (taken) {
      throw new Error(
        `Country "${taken}" already belongs to region "${countryOwner.get(taken)}". Run this seed on a fresh database.`
      )
    }
  }
  if (missingRegions.length) {
    const { result } = await createRegionsWorkflow(container).run({
      input: {
        regions: missingRegions.map((r) => ({
          name: r.name,
          currency_code: r.currency_code,
          countries: r.countries,
          payment_providers: ["pp_system_default"],
        })),
      },
    })
    result.forEach((r) => regionByName.set(r.name, r))
  }

  const existingTaxRegions = await taxModule.listTaxRegions({
    country_code: ALL_COUNTRIES,
  })
  const taxedCountries = new Set(existingTaxRegions.map((t) => t.country_code))
  const taxRegionsToCreate = REGIONS.flatMap((region) =>
    region.countries
      .filter((country) => !taxedCountries.has(country))
      .map((country_code) => ({
        country_code,
        provider_id: "tp_system",
        ...(region.tax_rate !== null
          ? {
              default_tax_rate: {
                rate: region.tax_rate,
                code: "VAT",
                name: "VAT",
              },
            }
          : {}),
      }))
  )
  if (taxRegionsToCreate.length) {
    await createTaxRegionsWorkflow(container).run({ input: taxRegionsToCreate })
  }

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        name: "Mercur Load Test Marketplace",
        default_sales_channel_id: salesChannel.id,
        default_region_id: regionByName.get(REGIONS[0].name)!.id,
      },
    },
  })

  logger.info("Seeding publishable API key...")
  const { data: keys } = await query.graph({
    entity: "api_key",
    fields: ["id", "token"],
    filters: { title: API_KEY_TITLE, type: "publishable" },
  })
  let apiKey = keys[0] as { id: string; token: string } | undefined
  if (!apiKey) {
    const { result } = await createApiKeysWorkflow(container).run({
      input: {
        api_keys: [{ title: API_KEY_TITLE, type: "publishable", created_by: "" }],
      },
    })
    apiKey = { id: result[0].id, token: result[0].token }
  }
  try {
    await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: { id: apiKey.id, add: [salesChannel.id] },
    })
  } catch (error: unknown) {
    if (!(error instanceof Error && error.message.includes("already"))) {
      throw error
    }
  }

  const { data: profiles } = await query.graph({
    entity: "shipping_profile",
    fields: ["id"],
    filters: { name: SHIPPING_PROFILE_NAME },
  })
  let shippingProfileId = (profiles[0] as { id: string } | undefined)?.id
  if (!shippingProfileId) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: SHIPPING_PROFILE_NAME, type: "default" }] },
    })
    shippingProfileId = result[0].id
  }

  logger.info("Seeding categories and collections...")
  const childNames = CATEGORY_PARENTS.flatMap((parent) =>
    CATEGORY_SUFFIXES.map((suffix) => `${parent} ${suffix}`)
  )
  const existingCategories = await productModule.listProductCategories(
    { name: [...CATEGORY_PARENTS, ...childNames] },
    { take: null }
  )
  const categoryByName = new Map(existingCategories.map((c) => [c.name, c]))

  const missingParents = CATEGORY_PARENTS.filter((n) => !categoryByName.has(n))
  if (missingParents.length) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: missingParents.map((name) => ({
          name,
          is_active: true,
          rank: CATEGORY_PARENTS.indexOf(name),
        })),
      },
    })
    result.forEach((c) => categoryByName.set(c.name, c))
  }
  const missingChildren = CATEGORY_PARENTS.flatMap((parent) =>
    CATEGORY_SUFFIXES.map((suffix, rank) => ({
      name: `${parent} ${suffix}`,
      is_active: true,
      rank,
      parent_category_id: categoryByName.get(parent)!.id,
    }))
  ).filter((c) => !categoryByName.has(c.name))
  if (missingChildren.length) {
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: { product_categories: missingChildren },
    })
    result.forEach((c) => categoryByName.set(c.name, c))
  }

  const existingCollections = await productModule.listProductCollections(
    { title: COLLECTION_TITLES },
    { take: null }
  )
  const collectionByTitle = new Map(existingCollections.map((c) => [c.title, c]))
  const missingCollections = COLLECTION_TITLES.filter(
    (t) => !collectionByTitle.has(t)
  )
  if (missingCollections.length) {
    const { result } = await createCollectionsWorkflow(container).run({
      input: { collections: missingCollections.map((title) => ({ title })) },
    })
    result.forEach((c) => collectionByTitle.set(c.title, c))
  }

  logger.info("Seeding product attributes...")
  const attributeDefs = [
    { name: "Size", handle: "size", values: SIZES },
    { name: "Color", handle: "color", values: COLORS },
  ]
  const loadAttributes = async () => {
    const { data } = await query.graph({
      entity: "product_attribute",
      fields: ["id", "handle", "values.id", "values.name"],
      filters: {
        handle: attributeDefs.map((a) => a.handle),
        product_id: null,
      },
    })
    return new Map((data as SeededAttribute[]).map((a) => [a.handle, a]))
  }
  let attributeByHandle = await loadAttributes()
  const missingAttributes = attributeDefs.filter(
    (a) => !attributeByHandle.has(a.handle)
  )
  if (missingAttributes.length) {
    await createProductAttributesWorkflow(container).run({
      input: {
        attributes: missingAttributes.map((attr, rank) => ({
          name: attr.name,
          handle: attr.handle,
          type: AttributeType.MULTI_SELECT,
          is_variant_axis: true,
          is_filterable: true,
          rank,
          values: attr.values.map((name, valueRank) => ({ name, rank: valueRank })),
        })),
      },
    })
    attributeByHandle = await loadAttributes()
  }

  const existingPromotions = await promotionModule.listPromotions({
    code: [PROMO_CODE],
  })
  if (!existingPromotions.length) {
    await createPromotionsWorkflow(container).run({
      input: {
        promotionsData: [
          {
            code: PROMO_CODE,
            type: "standard",
            status: "active",
            is_automatic: false,
            application_method: {
              type: "percentage",
              target_type: "order",
              allocation: "across",
              value: 10,
            },
          },
        ],
      },
    })
  }

  return {
    salesChannelId: salesChannel.id,
    publishableKey: apiKey.token,
    regions: REGIONS.map((r) => ({
      id: regionByName.get(r.name)!.id,
      name: r.name,
      currency_code: r.currency_code,
      countries: r.countries,
    })),
    shippingProfileId,
    categoryIds: childNames.map((n) => categoryByName.get(n)!.id),
    collectionIds: COLLECTION_TITLES.map((t) => collectionByTitle.get(t)!.id),
    sizeAttr: attributeByHandle.get("size")!,
    colorAttr: attributeByHandle.get("color")!,
  }
}

// The dump replaces the target's users, so the imported database needs its
// own operator: the Index module has to be re-synced through
// POST /admin/index/sync after every import.
async function ensureAdminUser(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const userModule = container.resolve(Modules.USER)
  const authModule = container.resolve(Modules.AUTH)

  const [existing] = await userModule.listUsers({ email: ADMIN_EMAIL })
  if (existing) {
    logger.info(`Admin user ${ADMIN_EMAIL} already exists.`)
    return
  }

  const password =
    process.env.PERF_ADMIN_PASSWORD || randomBytes(18).toString("base64url")
  const registered = await authModule.register("emailpass", {
    body: { email: ADMIN_EMAIL, password },
  })
  if (!registered.success || !registered.authIdentity) {
    throw new Error(
      `Could not register ${ADMIN_EMAIL}: ${registered.error ?? "unknown error"}`
    )
  }

  await createUserAccountWorkflow(container).run({
    input: {
      authIdentityId: registered.authIdentity.id,
      userData: { email: ADMIN_EMAIL, first_name: "Load", last_name: "Test" },
    },
  })

  logger.info(
    process.env.PERF_ADMIN_PASSWORD
      ? `Created admin user ${ADMIN_EMAIL} with PERF_ADMIN_PASSWORD.`
      : `Created admin user ${ADMIN_EMAIL} with password: ${password} (shown once, not saved)`
  )
}

async function createSeller(
  container: MedusaContainer,
  ctx: SetupResult,
  spec: ReturnType<typeof sellerSpec>
): Promise<SeededSeller> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const authModule = container.resolve(Modules.AUTH)

  let authIdentityId: string
  const registered = await authModule.register("emailpass", {
    body: { email: spec.email, password: SELLER_PASSWORD },
  })
  if (registered.success && registered.authIdentity) {
    authIdentityId = registered.authIdentity.id
  } else {
    const [identity] = await authModule.listProviderIdentities({
      entity_id: spec.email,
      provider: "emailpass",
    })
    authIdentityId = identity.auth_identity_id!
  }

  const { result: seller } = await createSellerAccountWorkflow(container).run({
    input: {
      auth_identity_id: authIdentityId,
      member_email: spec.email,
      first_name: "Load",
      last_name: `Seller ${spec.index + 1}`,
      region_ids: ctx.regions.map((r) => r.id),
      seller: {
        name: spec.name,
        email: spec.email,
        currency_code: "eur",
        description: `${spec.name} is a generated seller for marketplace load tests.`,
      },
    },
  })

  await approveSellerWorkflow(container).run({ input: { seller_id: seller.id } })

  const { data: members } = await query.graph({
    entity: "member",
    fields: ["id"],
    filters: { email: spec.email },
  })
  const memberId = (members[0] as { id: string }).id

  const { result: locations } = await createSellerStockLocationsWorkflow(
    container
  ).run({
    input: {
      seller_id: seller.id,
      locations: [
        {
          name: `${spec.name} Warehouse`,
          address: {
            city: "Load City",
            country_code: spec.country_code,
            address_1: `Warehouse street ${spec.index + 1}`,
          },
        },
      ],
    },
  })
  const stockLocationId = locations[0].id

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocationId },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  })

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: stockLocationId, add: [ctx.salesChannelId] },
  })

  await createLocationFulfillmentSetWorkflow(container).run({
    input: {
      location_id: stockLocationId,
      fulfillment_set_data: { name: `${spec.name} delivery`, type: "shipping" },
    },
  })

  const { data: locationsWithSets } = await query.graph({
    entity: "stock_location",
    fields: ["id", "fulfillment_sets.id"],
    filters: { id: stockLocationId },
  })
  const fulfillmentSetId = (
    locationsWithSets[0] as { fulfillment_sets?: { id: string }[] }
  ).fulfillment_sets?.[0]?.id
  if (!fulfillmentSetId) {
    throw new Error(`Fulfillment set was not created for "${spec.name}"`)
  }

  const { result: zones } = await createServiceZonesWorkflow(container).run({
    input: {
      data: [
        {
          fulfillment_set_id: fulfillmentSetId,
          name: `${spec.name} zone`,
          geo_zones: ALL_COUNTRIES.map((country_code) => ({
            country_code,
            type: "country" as const,
          })),
        },
      ],
    },
  })

  const option = (name: string, code: string, label: string, amount: number) => ({
    name,
    price_type: "flat" as const,
    provider_id: "manual_manual",
    service_zone_id: zones[0].id,
    shipping_profile_id: ctx.shippingProfileId,
    type: { label, description: label, code },
    prices: [
      { currency_code: "eur", amount },
      { currency_code: "usd", amount },
    ],
    rules: [
      { attribute: "enabled_in_store", value: "true", operator: "eq" as const },
      { attribute: "is_return", value: "false", operator: "eq" as const },
    ],
  })

  // The standard option is created last on purpose: its presence is what marks
  // a seller as fully seeded on the next run.
  await createSellerShippingOptionsWorkflow(container).run({
    input: {
      seller_id: seller.id,
      shipping_options: [option(`${spec.name} Express`, "express", "Express", 15)],
    },
  })
  await createSellerShippingOptionsWorkflow(container).run({
    input: {
      seller_id: seller.id,
      shipping_options: [option(spec.standardOptionName, "standard", "Standard", 5)],
    },
  })

  return { id: seller.id, memberId, stockLocationId }
}

async function seedSellers(
  container: MedusaContainer,
  ctx: SetupResult,
  count: number
): Promise<SeededSeller[]> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT)

  const specs = Array.from({ length: count }, (_, i) => sellerSpec(i))
  const sellers: SeededSeller[] = new Array(count)
  const toCreate: ReturnType<typeof sellerSpec>[] = []

  for (const batch of chunk(specs, LOOKUP_BATCH)) {
    const emails = batch.map((s) => s.email)
    const [{ data: existing }, { data: members }, locations, options] =
      await Promise.all([
        query.graph({
          entity: "seller",
          fields: ["id", "email"],
          filters: { email: emails },
        }),
        query.graph({
          entity: "member",
          fields: ["id", "email"],
          filters: { email: emails },
        }),
        stockLocationModule.listStockLocations(
          { name: batch.map((s) => `${s.name} Warehouse`) },
          { select: ["id", "name"], take: null }
        ),
        fulfillmentModule.listShippingOptions(
          { name: batch.map((s) => s.standardOptionName) },
          { select: ["id", "name"], take: null }
        ),
      ])

    const sellerByEmail = new Map(
      (existing as { id: string; email: string }[]).map((s) => [s.email, s.id])
    )
    const memberByEmail = new Map(
      (members as { id: string; email: string }[]).map((m) => [m.email, m.id])
    )
    const locationByName = new Map(locations.map((l) => [l.name, l.id]))
    const optionNames = new Set(options.map((o) => o.name))

    for (const spec of batch) {
      const sellerId = sellerByEmail.get(spec.email)
      if (!sellerId) {
        toCreate.push(spec)
        continue
      }
      const stockLocationId = locationByName.get(`${spec.name} Warehouse`)
      const memberId = memberByEmail.get(spec.email)
      if (!stockLocationId || !memberId || !optionNames.has(spec.standardOptionName)) {
        throw new Error(
          `Seller "${spec.email}" is only partially seeded. Delete it (or reset the database) and run the seed again.`
        )
      }
      sellers[spec.index] = { id: sellerId, memberId, stockLocationId }
    }
  }

  logger.info(
    `Sellers: ${count - toCreate.length} already seeded, creating ${toCreate.length}.`
  )
  const tick = progress("Sellers", toCreate.length, (m) => logger.info(m))
  await runPool(toCreate, CONCURRENCY, async (spec) => {
    sellers[spec.index] = await createSeller(container, ctx, spec)
    tick(1)
  })

  return sellers
}

async function ensureVariantPriceSets(
  container: MedusaContainer,
  productIds: string[]
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const pricingModule = container.resolve(Modules.PRICING)

  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "price_set.id"],
    filters: { product_id: productIds },
  })
  const missing = (
    data as { id: string; price_set?: { id: string } | null }[]
  ).filter((v) => !v.price_set?.id)
  if (!missing.length) {
    return
  }

  const priceSets = await pricingModule.createPriceSets(
    missing.map(() => ({ prices: [] }))
  )
  await link.create(
    missing.map((variant, i) => ({
      [Modules.PRODUCT]: { variant_id: variant.id },
      [Modules.PRICING]: { price_set_id: priceSets[i].id },
    }))
  )
}

async function seedProducts(
  container: MedusaContainer,
  ctx: SetupResult,
  count: number,
  createdBy: string
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const valueId = (attr: SeededAttribute, name: string) => {
    const value = attr.values.find((v) => v.name === name)
    if (!value) {
      throw new Error(`Attribute "${attr.handle}" has no value "${name}"`)
    }
    return value.id
  }

  // Mercur's wrapper passes these through to Medusa's createProductsWorkflow,
  // which links the product to the sales channel and shipping profile.
  type SeedProduct = CreateProductDTO & {
    sales_channels: { id: string }[]
    shipping_profile_id: string
  }

  const toProduct = (spec: ProductSpec): SeedProduct => {
    const rand = mulberry32(spec.index * 65537 + 5)
    const image = `https://picsum.photos/seed/${spec.handle}/800/800`
    return {
      title: spec.title,
      handle: spec.handle,
      description: `${spec.title} in ${spec.color.toLowerCase()}. Generated for marketplace load tests.`,
      status: ProductStatus.PUBLISHED,
      thumbnail: image,
      images: [{ url: image }],
      weight: 500,
      category_ids: [pick(rand, ctx.categoryIds)],
      collection_id: rand() < 0.6 ? pick(rand, ctx.collectionIds) : undefined,
      shipping_profile_id: ctx.shippingProfileId,
      sales_channels: [{ id: ctx.salesChannelId }],
      attributes: [
        { id: ctx.sizeAttr.id, value_ids: spec.sizes.map((s) => valueId(ctx.sizeAttr, s)) },
        { id: ctx.colorAttr.id, value_ids: [valueId(ctx.colorAttr, spec.color)] },
      ],
      variants: spec.sizes.map((size) => ({
        title: `${spec.color} / ${size}`,
        sku: `P${spec.index}-${size}`,
        options: { Size: size, Color: spec.color },
      })),
    }
  }

  const batches = chunk(
    Array.from({ length: count }, (_, i) => i),
    PRODUCT_BATCH
  )
  const tick = progress("Products", count, (m) => logger.info(m))

  await runPool(batches, CONCURRENCY, async (indices) => {
    const specs = indices.map(productSpec)
    const { data: existing } = await query.graph({
      entity: "product",
      fields: ["id", "handle"],
      filters: { handle: specs.map((s) => s.handle) },
    })
    const existingByHandle = new Map(
      (existing as { id: string; handle: string }[]).map((p) => [p.handle, p.id])
    )
    const missing = specs.filter((s) => !existingByHandle.has(s.handle))

    const productIds = Array.from(existingByHandle.values())
    if (missing.length) {
      const { result } = await createProductsWorkflow(container).run({
        input: { created_by: createdBy, products: missing.map(toProduct) },
      })
      productIds.push(...result.map((p) => p.id))
    }

    // Offers add their prices to the variant's price set and create it when
    // missing. Creating them here keeps parallel offer batches for different
    // sellers from racing to create the same variant's price set.
    await ensureVariantPriceSets(container, productIds)
    tick(indices.length)
  })
}

async function seedOffers(
  container: MedusaContainer,
  ctx: SetupResult,
  sellers: SeededSeller[],
  productCount: number
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const productsBySeller: number[][] = sellers.map(() => [])
  for (let i = 0; i < productCount; i++) {
    for (const s of sellersForProduct(i, sellers.length)) {
      productsBySeller[s].push(i)
    }
  }
  const assignments = productsBySeller.reduce((sum, p) => sum + p.length, 0)
  logger.info(
    `Offers: ${assignments} seller/product pairs across ${sellers.length} sellers.`
  )

  const tick = progress("Seller offers", sellers.length, (m) => logger.info(m))
  let created = 0

  await runPool(
    sellers.map((seller, index) => ({ seller, index })),
    CONCURRENCY,
    async ({ seller, index }) => {
      const offers: CreateOfferDTO[] = []

      for (const productIndices of chunk(productsBySeller[index], LOOKUP_BATCH)) {
        const specs = productIndices.map(productSpec)
        const specByHandle = new Map(specs.map((s) => [s.handle, s]))
        const { data: products } = await query.graph({
          entity: "product",
          fields: ["id", "handle", "variants.id", "variants.sku"],
          filters: { handle: specs.map((s) => s.handle) },
        })

        const candidates: CreateOfferDTO[] = []
        for (const product of products as {
          handle: string
          variants: { id: string; sku: string | null }[]
        }[]) {
          const spec = specByHandle.get(product.handle)!
          const rand = mulberry32(spec.index * 2654435 + index * 97 + 1)
          for (const variant of product.variants) {
            const sku = `S${index + 1}-${variant.sku}`
            const eur = Math.max(1, Math.round(spec.basePrice * (0.85 + rand() * 0.3)))
            candidates.push({
              seller_id: seller.id,
              created_by: seller.memberId,
              sku,
              variant_id: variant.id,
              shipping_profile_id: ctx.shippingProfileId,
              inventory_items: [
                {
                  sku,
                  stock_levels: [
                    {
                      location_id: seller.stockLocationId,
                      stocked_quantity: STOCK_PER_OFFER,
                    },
                  ],
                },
              ],
              prices: [
                { amount: eur, currency_code: "eur" },
                { amount: Math.round(eur * 1.08), currency_code: "usd" },
              ],
            })
          }
        }

        const { data: existing } = await query.graph({
          entity: "offer",
          fields: ["sku"],
          filters: { seller_id: seller.id, sku: candidates.map((o) => o.sku) },
        })
        const existingSkus = new Set((existing as { sku: string }[]).map((o) => o.sku))
        offers.push(...candidates.filter((o) => !existingSkus.has(o.sku)))
      }

      // createOffersWorkflow links every created inventory item to the first
      // offer's seller, so a batch must never mix sellers.
      for (const batch of chunk(offers, OFFER_BATCH)) {
        await createOffersWorkflow(container).run({ input: { offers: batch } })
        created += batch.length
      }
      tick(1)
    }
  )

  logger.info(`Offers: created ${created} new offers.`)
}

const countOf = async (container: MedusaContainer, entity: string) => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { metadata } = await query.graph({
    entity,
    fields: ["id"],
    pagination: { skip: 0, take: 1 },
  })
  return metadata?.count ?? 0
}

export default async function seedMarketplace({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const presetName = args[0] || "smoke"
  const base = PRESETS[presetName]
  if (!base) {
    throw new Error(
      `Unknown preset "${presetName}". Use one of: ${Object.keys(PRESETS).join(", ")}`
    )
  }
  const preset: Preset = {
    products: Number(process.env.PERF_PRODUCTS || base.products),
    sellers: Number(process.env.PERF_SELLERS || base.sellers),
  }

  const startedAt = Date.now()
  logger.info(
    `Seeding "${presetName}": ${preset.products} products, ${preset.sellers} sellers, concurrency ${CONCURRENCY}.`
  )

  const ctx = await setup(container)
  await ensureAdminUser(container)
  const sellers = await seedSellers(container, ctx, preset.sellers)
  await seedProducts(container, ctx, preset.products, sellers[0].memberId)
  await seedOffers(container, ctx, sellers, preset.products)

  const counts = {
    sellers: await countOf(container, "seller"),
    products: await countOf(container, "product"),
    variants: await countOf(container, "product_variant"),
    offers: await countOf(container, "offer"),
  }

  const fixtures = {
    dataset: presetName,
    endpoint: ENDPOINT,
    publishable_key: ctx.publishableKey,
    regions: ctx.regions,
    payment_provider_id: "pp_system_default",
    promo_code: PROMO_CODE,
    counts,
    seeded_at: new Date().toISOString(),
  }
  const fixturesDir = path.resolve(process.cwd(), "../../perf/fixtures")
  fs.mkdirSync(fixturesDir, { recursive: true })
  const fixturesPath = path.join(fixturesDir, `${presetName}.json`)
  fs.writeFileSync(fixturesPath, `${JSON.stringify(fixtures, null, 2)}\n`)

  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
  logger.info(
    `Done in ${minutes}m: ${counts.sellers} sellers, ${counts.products} products, ${counts.variants} variants, ${counts.offers} offers.`
  )
  logger.info(`Fixtures written to ${fixturesPath}`)
}
