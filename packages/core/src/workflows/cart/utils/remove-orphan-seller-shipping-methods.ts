import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { findOrphanSellerShippingMethods } from "./find-orphan-seller-shipping-methods"

export type CartShippingRows = {
  items?: Array<{ offer?: { seller_id?: string | null } | null } | null>
  shipping_methods?: Array<{
    id: string
    shipping_option_id?: string | null
  } | null>
}

export const cartShippingRowFields = [
  "id",
  "items.offer.seller_id",
  "shipping_methods.id",
  "shipping_methods.shipping_option_id",
]

// A seller's shipping method outlives its last line only until the cart is
// refreshed; the store API has no route to drop a method by hand.
export const removeOrphanSellerShippingMethodsFromCart = async (
  container: MedusaContainer,
  cart: CartShippingRows | undefined,
): Promise<string[]> => {
  const shippingMethods = (cart?.shipping_methods ?? []).filter(
    (method): method is NonNullable<typeof method> => !!method,
  )
  if (!shippingMethods.length) {
    return []
  }

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const optionIds = Array.from(
    new Set(
      shippingMethods
        .map((method) => method.shipping_option_id)
        .filter((id): id is string => !!id),
    ),
  )
  const { data: shippingOptions } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "seller.id"],
    filters: { id: optionIds },
  })

  const orphans = findOrphanSellerShippingMethods({
    items: (cart?.items ?? []).filter(
      (item): item is NonNullable<typeof item> => !!item,
    ),
    shippingMethods,
    shippingOptions: shippingOptions as Array<{
      id: string
      seller?: { id: string } | null
    }>,
  })
  if (!orphans.length) {
    return []
  }

  const cartModule = container.resolve(Modules.CART)
  const ids = orphans.map((method) => method.id)
  await cartModule.softDeleteShippingMethods(ids)
  return ids
}

export const removeOrphanSellerShippingMethods = async (
  container: MedusaContainer,
  cartId: string,
): Promise<string[]> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "cart",
    fields: cartShippingRowFields,
    filters: { id: cartId },
  })
  return removeOrphanSellerShippingMethodsFromCart(
    container,
    data[0] as CartShippingRows | undefined,
  )
}
