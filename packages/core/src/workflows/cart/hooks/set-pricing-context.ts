import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import { MedusaContainer } from "@medusajs/framework/types"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  addToCartWorkflow,
  refreshCartItemsWorkflow,
  updateLineItemInCartWorkflow,
} from "@medusajs/medusa/core-flows"
import { MercurModules } from "@mercurjs/types"
import { addOfferToCartWorkflow } from "../workflows/add-offer-to-cart"
import {
  CartShippingRows,
  cartShippingRowFields,
  removeOrphanSellerShippingMethodsFromCart,
} from "../utils/remove-orphan-seller-shipping-methods"

type OfferCarrier = {
  offer_id?: unknown
  metadata?: Record<string, unknown> | null
}

type RefreshCartLine = {
  id: string
  offer?: { id?: string; seller_id?: string | null } | null
  metadata?: Record<string, unknown> | null
}

type RefreshCartRows = CartShippingRows & {
  id: string
  items?: Array<RefreshCartLine | null>
}

const readOfferIdFromItem = (
  item: OfferCarrier | null | undefined,
): string | undefined => {
  if (typeof item?.offer_id === "string" && item.offer_id.length > 0) {
    return item.offer_id
  }
  const metaOfferId = item?.metadata?.offer_id
  if (typeof metaOfferId === "string" && metaOfferId.length > 0) {
    return metaOfferId
  }
  return undefined
}

const collectFromInputItems = (items: OfferCarrier[] | undefined): string[] => {
  if (!items?.length) return []
  const ids: string[] = []
  for (const item of items) {
    const id = readOfferIdFromItem(item)
    if (id) ids.push(id)
  }
  return ids
}

const readRefreshCart = async (
  container: MedusaContainer,
  cartId: string,
): Promise<RefreshCartRows | undefined> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: rows } = await query.graph({
    entity: "cart",
    fields: [...cartShippingRowFields, "items.id", "items.offer.id", "items.metadata"],
    filters: { id: cartId },
  })
  return rows[0] as RefreshCartRows | undefined
}

const collectFromCartLines = (cart: RefreshCartRows | undefined): string[] => {
  const ids: string[] = []
  for (const item of cart?.items ?? []) {
    if (item?.offer?.id) {
      ids.push(item.offer.id)
      continue
    }
    const fromMeta = readOfferIdFromItem(item)
    if (fromMeta) ids.push(fromMeta)
  }
  return ids
}

// Lines are created with the offer id in their metadata; the line ↔ offer link
// is attached on the first refresh, which runs inside every add/update flow.
const linkUnlinkedLines = async (
  container: MedusaContainer,
  cart: RefreshCartRows | undefined,
): Promise<void> => {
  const linksToCreate: Array<{ line_item_id: string; offer_id: string }> = []
  for (const item of cart?.items ?? []) {
    if (!item || item.offer?.id) continue
    const offerId = item.metadata?.offer_id
    if (typeof offerId !== "string" || !offerId.length) continue
    linksToCreate.push({ line_item_id: item.id, offer_id: offerId })
  }
  if (!linksToCreate.length) return

  const link = container.resolve(ContainerRegistrationKeys.LINK)
  await link.create(
    linksToCreate.map((row) => ({
      [Modules.CART]: { line_item_id: row.line_item_id },
      [MercurModules.OFFER]: { offer_id: row.offer_id },
    })),
  )
}

const addToCartPricingContext = async ({
  cart,
  items,
}: {
  cart?: { items?: Array<{ offer?: { id?: string } | null }> | null } | null
  items?: OfferCarrier[]
}) => {
  const ids = new Set<string>()
  for (const id of collectFromInputItems(items)) ids.add(id)
  for (const item of cart?.items ?? []) {
    if (item.offer?.id) ids.add(item.offer.id)
  }
  if (!ids.size) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Every cart line item must resolve to an offer_id",
    )
  }
  return new StepResponse({ offer_id: Array.from(ids) })
}

addToCartWorkflow.hooks.setPricingContext(async ({ cart, items }) =>
  addToCartPricingContext({ cart, items }),
)

addOfferToCartWorkflow.hooks.setPricingContext(async ({ cart, items }) =>
  addToCartPricingContext({ cart, items }),
)

updateLineItemInCartWorkflow.hooks.setPricingContext(
  async ({ cart, item }, { container }) => {
    const ids = new Set<string>()
    for (const cartItem of (cart?.items ?? []) as Array<{
      id: string
      offer?: { id?: string } | null
    }>) {
      if (cartItem.offer?.id) ids.add(cartItem.offer.id)
    }
    const updatedOffer = (item as { offer?: { id?: string } } | null)?.offer
      ?.id
    if (updatedOffer) ids.add(updatedOffer)

    if (!ids.size && cart?.id) {
      const rows = await readRefreshCart(container, cart.id)
      for (const id of collectFromCartLines(rows)) ids.add(id)
    }
    if (!ids.size) {
      return new StepResponse({})
    }
    return new StepResponse({ offer_id: Array.from(ids) })
  },
)

// One cart read serves the three things a refresh needs before it re-reads the
// cart itself: dropping shipping methods whose seller left the cart (they would
// otherwise survive into the shipping and payment-collection refreshes),
// linking fresh lines to their offers, and the offer ids for the pricing
// context.
refreshCartItemsWorkflow.hooks.setPricingContext(
  async ({ cart_id, items }, { container }) => {
    const ids = new Set<string>()
    for (const id of collectFromInputItems(items)) ids.add(id)

    if (cart_id) {
      const cart = await readRefreshCart(container, cart_id)
      await Promise.all([
        removeOrphanSellerShippingMethodsFromCart(container, cart),
        linkUnlinkedLines(container, cart),
      ])
      for (const id of collectFromCartLines(cart)) ids.add(id)
    }

    if (!ids.size) {
      return new StepResponse({})
    }
    return new StepResponse({ offer_id: Array.from(ids) })
  },
)
