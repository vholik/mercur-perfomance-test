import { BigNumberInput, MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  MathBN,
  MedusaError,
  Modules,
  promiseAll,
} from "@medusajs/framework/utils"
import {
  addToCartWorkflow,
  updateLineItemInCartWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  OfferInventoryShape,
  prepareOfferInventoryInput,
  requiredOfferFieldsForInventoryConfirmation,
  resolveSalesChannelLocationIds,
} from "../../offer/utils"
import { resolveOrderableSellerIds } from "../../seller/utils"

type OfferDemandLine = {
  id: string
  quantity: BigNumberInput
  offer_id: string
}

type CartOfferLine = OfferDemandLine & { variant_id?: string | null }

const resolveCartOfferLines = async (
  container: MedusaContainer,
  cartId: string,
): Promise<CartOfferLine[]> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: ["items.id", "items.quantity", "items.variant_id", "items.offer.id"],
    filters: { id: cartId },
  })

  const items = (data[0]?.items ?? []) as Array<{
    id: string
    quantity: BigNumberInput
    variant_id?: string | null
    offer?: { id?: string } | null
  } | null>

  return items.flatMap((item) =>
    item?.offer?.id
      ? [
          {
            id: item.id,
            quantity: item.quantity,
            variant_id: item.variant_id,
            offer_id: item.offer.id,
          },
        ]
      : [],
  )
}

type InventoryOffer = OfferInventoryShape & { seller_id?: string | null }

const offerFieldsForAddToCart = [
  ...requiredOfferFieldsForInventoryConfirmation,
  "seller_id",
]

const readOffers = async (
  container: MedusaContainer,
  offerIds: string[],
  fields: string[] = requiredOfferFieldsForInventoryConfirmation,
): Promise<InventoryOffer[]> => {
  if (!offerIds.length) {
    return []
  }
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "offer",
    fields,
    filters: { id: offerIds },
  })
  return data as InventoryOffer[]
}

// Several lines can draw on one inventory item: the same offer added again
// before Medusa merges it, or different offers sharing an item through
// inventory kits. Stock is confirmed against the cart's total demand per item,
// not line by line.
const hasCartOfferInventoryCoverage = async ({
  container,
  salesChannelId,
  channelLocationIds,
  lines,
  checkedLineIds,
  offers,
}: {
  container: MedusaContainer
  salesChannelId?: string
  channelLocationIds?: string[]
  lines: OfferDemandLine[]
  checkedLineIds: Set<string>
  offers: InventoryOffer[]
}): Promise<boolean> => {
  const inventoryService = container.resolve(Modules.INVENTORY)

  const foundIds = new Set(offers.map((o: { id: string }) => o.id))
  const missing = lines.find(
    (l) => checkedLineIds.has(l.id) && !foundIds.has(l.offer_id),
  )
  if (missing) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Offer ${missing.offer_id} not found`,
    )
  }

  const { items: entries } = prepareOfferInventoryInput({
    input: {
      sales_channel_id: salesChannelId,
      channel_location_ids: channelLocationIds,
      items: lines
        .filter((l) => foundIds.has(l.offer_id))
        .map((l) => ({
          id: l.id,
          quantity: l.quantity,
          offer: { id: l.offer_id },
        })),
      offers: offers as OfferInventoryShape[],
    },
  })

  const demandByItem = new Map<
    string,
    { units: BigNumberInput; locationIds: Set<string>; checked: boolean }
  >()

  for (const entry of entries) {
    if (!entry.manage_inventory) {
      continue
    }

    const demand = demandByItem.get(entry.inventory_item_id) ?? {
      units: 0,
      locationIds: new Set<string>(),
      checked: false,
    }
    demand.units = MathBN.add(
      demand.units,
      MathBN.mult(entry.required_quantity, entry.quantity),
    )
    if (
      entry.id &&
      checkedLineIds.has(entry.id) &&
      !entry.allow_backorder
    ) {
      demand.checked = true
      entry.location_ids.forEach((id) => demand.locationIds.add(id))
    }
    demandByItem.set(entry.inventory_item_id, demand)
  }

  const coverage = await promiseAll(
    Array.from(demandByItem.entries())
      .filter(([, demand]) => demand.checked)
      .map(([inventoryItemId, demand]) =>
        inventoryService.confirmInventory(
          inventoryItemId,
          Array.from(demand.locationIds),
          demand.units,
        ),
      ),
  )

  return coverage.every(Boolean)
}

// Medusa calculates prices per variant, so two offers on one variant would
// both resolve to the cheaper offer's price. A variant is sold by one offer
// per cart; switching offers means removing the line first.
const validateOneOfferPerVariant = (
  existing: CartOfferLine[],
  incoming: Array<{ variant_id?: string; offer_id: string }>,
): void => {
  const offerByVariant = new Map<string, string>()
  for (const item of existing) {
    if (item.variant_id) {
      offerByVariant.set(item.variant_id, item.offer_id)
    }
  }

  for (const item of incoming) {
    if (!item.variant_id) {
      continue
    }
    const existingOfferId = offerByVariant.get(item.variant_id)
    if (existingOfferId && existingOfferId !== item.offer_id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Variant ${item.variant_id} is already in the cart through offer ${existingOfferId}. Remove that line before adding offer ${item.offer_id}.`,
      )
    }
    offerByVariant.set(item.variant_id, item.offer_id)
  }
}

const validateOrderableSellers = async (
  container: MedusaContainer,
  offerIds: string[],
  offers: InventoryOffer[],
): Promise<void> => {
  const found = new Map(offers.map((offer) => [offer.id, offer]))
  const missing = offerIds.find((id) => !found.has(id))
  if (missing) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Offer ${missing} was not found`,
    )
  }
  const incoming = offerIds.map((id) => found.get(id)!)
  const sellerIds = [
    ...new Set(
      incoming
        .map((offer) => offer.seller_id)
        .filter((id): id is string => !!id),
    ),
  ]
  const orderable = new Set(
    sellerIds.length ? await resolveOrderableSellerIds(container, sellerIds) : [],
  )
  const unavailable = incoming.find(
    (offer) => !offer.seller_id || !orderable.has(offer.seller_id),
  )
  if (unavailable) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Offer ${unavailable.id} is not available: its seller is not accepting orders`,
    )
  }
}

// The cart lines and the offers (incoming and already in the cart) are read
// once each, in parallel, and feed the three checks below.
addToCartWorkflow.hooks.validate(async ({ input, cart }, { container }) => {
  const incoming = (input.items ?? []).filter(
    (i): i is typeof i & { offer_id: string } =>
      typeof i.offer_id === "string" && i.offer_id.length > 0,
  )
  if (!incoming.length) {
    return
  }

  const incomingOfferIds = [...new Set(incoming.map((i) => i.offer_id))]
  const [existingLines, channelLocationIds] = await promiseAll([
    resolveCartOfferLines(container, cart.id),
    resolveSalesChannelLocationIds(container, cart.sales_channel_id),
  ])
  const offers = await readOffers(
    container,
    [
      ...new Set([
        ...incomingOfferIds,
        ...existingLines.map((line) => line.offer_id),
      ]),
    ],
    offerFieldsForAddToCart,
  )

  validateOneOfferPerVariant(existingLines, incoming)
  await validateOrderableSellers(container, incomingOfferIds, offers)

  const incomingLines = incoming.map((i, index) => ({
    id: `incoming_${index}`,
    quantity: i.quantity,
    offer_id: i.offer_id,
  }))

  const covered = await hasCartOfferInventoryCoverage({
    container,
    salesChannelId: cart.sales_channel_id ?? undefined,
    channelLocationIds,
    lines: [...existingLines, ...incomingLines],
    checkedLineIds: new Set(incomingLines.map((l) => l.id)),
    offers,
  })

  if (!covered) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Some inventory item linked to an offer does not have sufficient stock",
      MedusaError.Codes.INSUFFICIENT_INVENTORY,
    )
  }
})

updateLineItemInCartWorkflow.hooks.validate(
  async ({ input, cart }, { container }) => {
    const newQuantity = input.update?.quantity
    if (newQuantity === undefined || newQuantity === null) {
      return
    }
    if (MathBN.lte(newQuantity, 0)) {
      return
    }

    const [cartLines, channelLocationIds] = await promiseAll([
      resolveCartOfferLines(container, cart.id),
      resolveSalesChannelLocationIds(container, cart.sales_channel_id),
    ])
    const lines = cartLines.map((l) =>
      l.id === input.item_id ? { ...l, quantity: newQuantity } : l,
    )
    if (!lines.some((l) => l.id === input.item_id)) {
      return
    }

    const covered = await hasCartOfferInventoryCoverage({
      container,
      salesChannelId: cart.sales_channel_id ?? undefined,
      channelLocationIds,
      lines,
      checkedLineIds: new Set([input.item_id]),
      offers: await readOffers(
        container,
        [...new Set(lines.map((l) => l.offer_id))],
      ),
    })

    if (!covered) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Cannot increase quantity: an inventory item linked to the offer is out of stock",
        MedusaError.Codes.INSUFFICIENT_INVENTORY,
      )
    }
  },
)
