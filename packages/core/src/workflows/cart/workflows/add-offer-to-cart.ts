import { AdditionalData, BigNumberInput } from "@medusajs/framework/types"
import {
    CartWorkflowEvents,
    filterObjectByKeys,
    isDefined,
    MedusaError,
    Modules,
    ProductStatus,
    PromotionActions,
    simpleHash,
} from "@medusajs/framework/utils"
import {
    createHook,
    createWorkflow,
    parallelize,
    transform,
    when,
    WorkflowData,
    WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
    acquireLockStep,
    createLineItemsStep,
    emitEventStep,
    getLineItemActionsStep,
    getLineItemPricingQuantitiesStep,
    getTranslatedLineItemsStep,
    getVariantPriceSetsStep,
    refreshCartShippingMethodsWorkflow,
    refreshPaymentCollectionForCartWorkflow,
    releaseLockStep,
    updateCartPromotionsWorkflow,
    updateLineItemsStep,
    upsertTaxLinesWorkflow,
    useQueryGraphStep,
    validateCartStep,
    validateLineItemPricesStep,
} from "@medusajs/medusa/core-flows"
import { MercurModules } from "@mercurjs/types"
import { createLinksStep } from "../../common/steps"
import {
    cartFieldsForPricingContext,
    cartFieldsForRefreshSteps,
    prepareLineItemData,
    pricingContextResult,
} from "../utils"

export type AddOfferToCartWorkflowInput = {
    cart_id: string
    items: Array<{
        offer_id: string
        variant_id: string
        quantity: BigNumberInput
        unit_price?: BigNumberInput
        is_tax_inclusive?: boolean
        requires_shipping?: boolean
        metadata?: Record<string, unknown> | null
    }>
} & AdditionalData

const cartFields = [
    "completed_at",
    "locale",
    "items.id",
    "items.offer.id",
    ...cartFieldsForPricingContext,
]

const variantFields = [
    "id",
    "title",
    "sku",
    "manage_inventory",
    "allow_backorder",
    "requires_shipping",
    "is_discountable",
    "variant_option_values",
    "barcode",
    "thumbnail",
    "product.id",
    "product.title",
    "product.description",
    "product.status",
    "product.subtitle",
    "product.thumbnail",
    "product.type.value",
    "product.type.id",
    "product.collection.id",
    "product.collection.title",
    "product.handle",
    "product.discountable",
    "product.is_giftcard",
    "product.shipping_profile.id",
    "inventory_items.inventory_item_id",
    "inventory_items.required_quantity",
    "inventory_items.inventory.id",
    "inventory_items.inventory.requires_shipping",
]

type CreatedLine = { id: string; metadata?: Record<string, unknown> | null }

type PricedVariant = NonNullable<
    Parameters<typeof prepareLineItemData>[0]["variant"]
> & { product?: { status?: string } }

export const addOfferToCartWorkflowId = "add-offer-to-cart"

/**
 * Medusa's add-to-cart, with the marketplace's refresh. The stock check runs
 * against the offers in the `validate` hook, not Medusa's variant inventory,
 * and after the lines are written the cart is refreshed only where the new
 * lines changed something: shipping methods when the cart has any, item tax
 * lines, promotions when codes are applied, and the payment collection when
 * one exists.
 */
export const addOfferToCartWorkflow = createWorkflow(
    {
        name: addOfferToCartWorkflowId,
        idempotent: false,
    },
    (input: WorkflowData<AddOfferToCartWorkflowInput>) => {
        acquireLockStep({
            key: input.cart_id,
            timeout: 2,
            ttl: 10,
        })

        const { data: cart } = useQueryGraphStep({
            entity: "cart",
            filters: { id: input.cart_id },
            fields: cartFields,
            options: { throwIfKeyNotFound: true, isList: false },
        }).config({ name: "get-cart" })

        validateCartStep({ cart })

        const validate = createHook("validate", {
            input,
            cart,
        })

        const variantIds = transform({ input }, ({ input }) =>
            input.items.map((item) => item.variant_id)
        )

        const setPricingContext = createHook(
            "setPricingContext",
            {
                cart,
                variantIds,
                items: input.items,
                additional_data: input.additional_data,
            },
            {
                resultValidator: pricingContextResult,
            }
        )
        const setPricingContextResult = setPricingContext.getResult()

        const pricingQuantities = getLineItemPricingQuantitiesStep({
            id: input.cart_id,
            items: input.items,
        })

        // Medusa's variant pricing sub-workflow is not exported, so this is
        // the same query and price-set lookup, with the offer ids from the
        // pricing context deciding which seller's price applies.
        const cartPricingContext = transform(
            { cart, items: input.items, pricingQuantities, setPricingContextResult },
            ({ cart, items, pricingQuantities, setPricingContextResult }) => {
                const baseContext = {
                    ...filterObjectByKeys(cart, cartFieldsForPricingContext),
                    customer: cart.customer,
                    ...(setPricingContextResult ?? {}),
                    currency_code: cart.currency_code,
                    region_id: cart.region_id,
                    customer_id: cart.customer_id,
                }

                return items.map((item, index) => ({
                    id: simpleHash(JSON.stringify(item)),
                    variantId: item.variant_id,
                    context: {
                        ...baseContext,
                        quantity: pricingQuantities[index] ?? item.quantity,
                        is_custom_price: isDefined(item.unit_price),
                    },
                }))
            }
        )

        const { data: variants } = useQueryGraphStep({
            entity: "variants",
            fields: variantFields,
            filters: { id: variantIds },
            options: {
                cache: {
                    tags: ["ProductVariant:list:*"],
                    computeAutomaticTags: true,
                },
            },
        }).config({ name: "fetch-variants" })

        const calculatedPriceSets = getVariantPriceSetsStep({
            data: cartPricingContext,
        })

        const lineItems = transform(
            { variants, calculatedPriceSets, input },
            ({ variants, calculatedPriceSets, input }) => {
                const variantsById = new Map(
                    (variants as PricedVariant[]).map((variant) => [variant.id, variant])
                )
                const unpublished: string[] = []
                const unpriced: string[] = []

                const items = input.items.map((item) => {
                    const variant = variantsById.get(item.variant_id)
                    const priceSet =
                        calculatedPriceSets[simpleHash(JSON.stringify(item))] ??
                        calculatedPriceSets[item.variant_id]
                    const isCustomPrice = isDefined(item.unit_price)

                    if (!variant || variant.product?.status !== ProductStatus.PUBLISHED) {
                        unpublished.push(item.variant_id)
                    }
                    if (!priceSet && !isCustomPrice) {
                        unpriced.push(item.variant_id)
                    }
                    if (variant) {
                        variant.calculated_price = priceSet
                    }

                    return prepareLineItemData({
                        item,
                        variant,
                        cartId: input.cart_id,
                        unitPrice: isCustomPrice ? item.unit_price : priceSet?.calculated_amount,
                        isTaxInclusive: isCustomPrice
                            ? !!item.is_tax_inclusive
                            : !!priceSet?.is_calculated_price_tax_inclusive,
                        isCustomPrice,
                    })
                })

                if (unpublished.length) {
                    throw new MedusaError(
                        MedusaError.Types.INVALID_DATA,
                        `Variants ${unpublished.join(", ")} do not exist or belong to a product that is not published`
                    )
                }
                if (unpriced.length) {
                    throw new MedusaError(
                        MedusaError.Types.INVALID_DATA,
                        `Variants with IDs ${unpriced.join(", ")} do not have a price`
                    )
                }

                return items
            }
        )

        validateLineItemPricesStep({ items: lineItems })

        const { itemsToCreate = [], itemsToUpdate = [] } = getLineItemActionsStep({
            id: cart.id,
            items: lineItems,
        })

        const itemsToCreateVariants = transform(
            { itemsToCreate, variants },
            ({ itemsToCreate, variants }) => {
                const variantsById = new Map(
                    (variants as PricedVariant[]).map((variant) => [variant.id, variant])
                )
                return itemsToCreate
                    .map((item) => item.variant_id && variantsById.get(item.variant_id))
                    .filter(Boolean) as PricedVariant[]
            }
        )

        const translatedItemsToCreate = getTranslatedLineItemsStep({
            items: itemsToCreate,
            variants: itemsToCreateVariants,
            locale: cart.locale,
        })

        const [createdLineItems, updatedLineItems] = parallelize(
            createLineItemsStep({
                id: cart.id,
                items: translatedItemsToCreate,
            }),
            updateLineItemsStep({
                id: cart.id,
                items: itemsToUpdate,
            })
        )

        const allItems = transform(
            { createdLineItems, updatedLineItems },
            ({ createdLineItems = [], updatedLineItems = [] }) =>
                createdLineItems.concat(updatedLineItems)
        )

        // New lines carry the offer id in their metadata; the line ↔ offer
        // link is what every later read of the cart goes through.
        const offerLinks = transform({ createdLineItems }, ({ createdLineItems = [] }) =>
            (createdLineItems as CreatedLine[]).flatMap((line) => {
                const offerId = line.metadata?.offer_id
                return typeof offerId === "string" && offerId.length
                    ? [
                          {
                              [Modules.CART]: { line_item_id: line.id },
                              [MercurModules.OFFER]: { offer_id: offerId },
                          },
                      ]
                    : []
            })
        )

        const [, { data: refetchedCart }] = parallelize(
            createLinksStep(offerLinks),
            useQueryGraphStep({
                entity: "cart",
                fields: cartFieldsForRefreshSteps,
                filters: { id: cart.id },
                options: { isList: false },
            }).config({ name: "refetch-cart" })
        )

        refreshCartShippingMethodsWorkflow.runAsStep({
            input: {
                cart: refetchedCart,
                additional_data: input.additional_data,
            },
        })

        upsertTaxLinesWorkflow.runAsStep({
            input: transform(
                { refetchedCart, allItems },
                ({ refetchedCart, allItems }) => ({
                    cart: refetchedCart,
                    items: allItems,
                    shipping_methods: [],
                })
            ),
        })

        const cartPromoCodes = transform({ refetchedCart }, ({ refetchedCart }) =>
            (refetchedCart.promotions ?? [])
                .map((promotion) => promotion?.code)
                .filter((code): code is string => Boolean(code))
        )

        when("refresh-cart-promotions", { cartPromoCodes }, ({ cartPromoCodes }) => {
            return cartPromoCodes.length > 0
        }).then(() => {
            updateCartPromotionsWorkflow.runAsStep({
                input: {
                    cart_id: cart.id,
                    promo_codes: cartPromoCodes,
                    action: PromotionActions.REPLACE,
                    force_refresh_payment_collection: false,
                },
            })
        })

        refreshPaymentCollectionForCartWorkflow.runAsStep({
            input: { cart: refetchedCart },
        })

        parallelize(
            emitEventStep({
                eventName: CartWorkflowEvents.UPDATED,
                data: { id: cart.id },
            }),
            releaseLockStep({
                key: cart.id,
            })
        )

        return new WorkflowResponse(void 0, {
            hooks: [validate, setPricingContext],
        })
    }
)
