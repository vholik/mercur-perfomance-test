import { BigNumberInput, MedusaContainer } from "@medusajs/framework/types"
import {
  BigNumber,
  ContainerRegistrationKeys,
  MathBN,
  MedusaError,
} from "@medusajs/framework/utils"

// `defineLink(...isList: true, isList: true, { extraColumns })` exposes
// the pivot row on the writable side under the `<entity>_link` alias
// (here: `offer.inventory_item_link[]`). Each row carries the pivot's
// `id`, `required_quantity` (extra column), the foreign keys, and a
// nested `inventory_item` relationship to the linked `InventoryItem`.
// We must request fields off the pivot to get `required_quantity`; the
// `offer.inventory_items[]` shortcut flattens to the `InventoryItem`
// rows directly and does not expose pivot columns.
export const requiredOfferFieldsForInventoryConfirmation = [
  "id",
  "manage_inventory",
  "allow_backorder",
  "inventory_item_link.required_quantity",
  "inventory_item_link.inventory_item.id",
  "inventory_item_link.inventory_item.location_levels.location_id",
  "inventory_item_link.inventory_item.location_levels.stocked_quantity",
  "inventory_item_link.inventory_item.location_levels.reserved_quantity",
  "inventory_item_link.inventory_item.location_levels.raw_stocked_quantity",
  "inventory_item_link.inventory_item.location_levels.raw_reserved_quantity",
]

// Which locations serve a sales channel changes with configuration, not with
// carts, so the two extra joiner hops per inventory read (location level →
// stock location → sales channels) are replaced by this cached lookup. Tags as
// in Medusa's `salesChannelStockLocationCacheTags`: both hops are link tables
// whose rows fire only their own link events.
export const salesChannelLocationCacheTags = [
  "SalesChannel:list:*",
  "LinkSalesChannelStockLocation:list:*",
]

export const salesChannelLocationFields = ["id", "stock_locations.id"]

export const resolveSalesChannelLocationIds = async (
  container: MedusaContainer,
  salesChannelId: string | null | undefined,
): Promise<string[] | undefined> => {
  if (!salesChannelId) {
    return undefined
  }
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph(
    {
      entity: "sales_channels",
      fields: salesChannelLocationFields,
      filters: { id: salesChannelId },
    },
    {
      cache: {
        enable: true,
        tags: salesChannelLocationCacheTags,
        computeAutomaticTags: true,
      },
    },
  )
  return toSalesChannelLocationIds(data)
}

export const toSalesChannelLocationIds = (
  channels: Array<{ stock_locations?: Array<{ id: string } | null> | null } | null>,
): string[] =>
  (channels ?? []).flatMap((channel) =>
    (channel?.stock_locations ?? []).flatMap((location) =>
      location?.id ? [location.id] : [],
    ),
  )

export type OfferInventoryItemLinkRow = {
  required_quantity?: number
  inventory_item: {
    id: string
    location_levels?: Array<{
      location_id: string
      stocked_quantity?: BigNumberInput
      reserved_quantity?: BigNumberInput
      raw_stocked_quantity?: BigNumberInput
      raw_reserved_quantity?: BigNumberInput
      stock_locations?: Array<{
        id: string
        sales_channels?: Array<{ id: string }>
      }>
    }>
  }
}

export type OfferInventoryShape = {
  id: string
  manage_inventory?: boolean
  allow_backorder?: boolean
  inventory_item_link?: OfferInventoryItemLinkRow[]
}

export type PrepareOfferInventoryInputData = {
  input: {
    sales_channel_id?: string
    /**
     * Stock locations attached to `sales_channel_id` (see
     * `resolveSalesChannelLocationIds`). When given, the location levels'
     * `stock_locations.sales_channels` relation is not consulted.
     */
    channel_location_ids?: string[]
    items: Array<{
      id?: string
      quantity: BigNumberInput
      offer?: { id: string } | null
    }>
    offers: OfferInventoryShape[]
  }
}

export type OfferConfirmInventoryItem = {
  id?: string
  inventory_item_id: string
  required_quantity: number
  manage_inventory: boolean
  allow_backorder: boolean
  quantity: BigNumberInput
  location_ids: string[]
}

export const prepareOfferInventoryInput = (
  data: PrepareOfferInventoryInputData,
): { items: OfferConfirmInventoryItem[] } => {
  const { sales_channel_id, channel_location_ids, items, offers } = data.input
  const channelLocationSet = channel_location_ids
    ? new Set(channel_location_ids)
    : undefined

  if (!items?.length) {
    return { items: [] }
  }

  const offerById = new Map<string, OfferInventoryShape>(
    offers.map((o) => [o.id, o]),
  )

  const availability = new Map<string, Map<string, Map<string, BigNumber>>>()
  const channelLocations = new Map<string, Set<string>>()
  const anyLocations = new Map<string, Set<string>>()
  const requiredByPivot = new Map<string, number>()

  for (const offer of offers) {
    const offerAvail = availability.get(offer.id) ?? new Map()
    availability.set(offer.id, offerAvail)

    for (const link of offer.inventory_item_link ?? []) {
      const inventoryItemId = link.inventory_item.id
      const itemAvail = offerAvail.get(inventoryItemId) ?? new Map()
      offerAvail.set(inventoryItemId, itemAvail)

      const itemAny =
        anyLocations.get(`${offer.id}:${inventoryItemId}`) ??
        new Set<string>()
      anyLocations.set(`${offer.id}:${inventoryItemId}`, itemAny)

      const itemChannel =
        channelLocations.get(`${offer.id}:${inventoryItemId}`) ??
        new Set<string>()
      channelLocations.set(`${offer.id}:${inventoryItemId}`, itemChannel)

      requiredByPivot.set(
        `${offer.id}:${inventoryItemId}`,
        link.required_quantity ?? 1,
      )

      for (const lvl of link.inventory_item.location_levels ?? []) {
        const stocked = MathBN.sub(
          (lvl.raw_stocked_quantity as any)?.value ??
            lvl.stocked_quantity ??
            0,
          (lvl.raw_reserved_quantity as any)?.value ??
            lvl.reserved_quantity ??
            0,
        )
        itemAvail.set(lvl.location_id, new BigNumber(stocked))
        itemAny.add(lvl.location_id)

        if (channelLocationSet) {
          if (sales_channel_id && channelLocationSet.has(lvl.location_id)) {
            itemChannel.add(lvl.location_id)
          }
          continue
        }

        for (const sl of lvl.stock_locations ?? []) {
          if (
            sales_channel_id &&
            sl.sales_channels?.some((sc) => sc.id === sales_channel_id)
          ) {
            itemChannel.add(sl.id)
          }
        }
      }
    }
  }

  const result: OfferConfirmInventoryItem[] = []

  for (const item of items) {
    const offerId = item.offer?.id
    if (!offerId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "prepareOfferInventoryInput received a cart item with no resolved offer",
      )
    }

    const offer = offerById.get(offerId)
    if (!offer) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Offer ${offerId} could not be resolved for the inventory check`,
      )
    }

    const inventoryLinks = offer.inventory_item_link ?? []
    if (!inventoryLinks.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Offer ${offerId} has no inventory items linked`,
      )
    }

    for (const link of inventoryLinks) {
      const inventoryItemId = link.inventory_item.id
      const offerAvail = availability.get(offer.id) ?? new Map()
      const itemAvail =
        (offerAvail.get(inventoryItemId) as
          | Map<string, BigNumber>
          | undefined) ?? new Map<string, BigNumber>()
      const itemAny =
        anyLocations.get(`${offer.id}:${inventoryItemId}`) ?? new Set()

      const requiredQuantity =
        requiredByPivot.get(`${offer.id}:${inventoryItemId}`) ?? 1
      const required = MathBN.mult(requiredQuantity, item.quantity)

      const manageInventory = offer.manage_inventory ?? true
      const allowBackorder = offer.allow_backorder ?? false

      // Like Medusa's prepareConfirmInventoryInput: a cart on a sales channel
      // only draws on that channel's locations.
      const itemChannel =
        channelLocations.get(`${offer.id}:${inventoryItemId}`) ?? new Set()
      if (
        sales_channel_id &&
        !itemChannel.size &&
        manageInventory &&
        !allowBackorder
      ) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Sales channel ${sales_channel_id} is not associated with any stock location for offer ${offer.id}.`,
        )
      }

      const candidates =
        sales_channel_id && itemChannel.size ? itemChannel : itemAny

      const fullLocations: string[] = []
      for (const locId of candidates) {
        if (MathBN.gte(itemAvail.get(locId) ?? 0, required)) {
          fullLocations.push(locId)
        }
      }

      const dedup = new Set<string>([...fullLocations, ...candidates])

      result.push({
        id: item.id,
        inventory_item_id: inventoryItemId,
        required_quantity: requiredQuantity,
        manage_inventory: manageInventory,
        allow_backorder: allowBackorder,
        quantity: item.quantity,
        location_ids: Array.from(dedup),
      })
    }
  }

  return { items: result }
}
