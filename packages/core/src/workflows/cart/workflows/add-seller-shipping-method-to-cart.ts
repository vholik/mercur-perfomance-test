import { CartWorkflowEvents, MedusaError, PromotionActions } from "@medusajs/framework/utils"
import {
    createHook,
    createWorkflow,
    parallelize,
    transform,
    WorkflowData,
    WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, addShippingMethodToCartStep, AddShippingMethodToCartWorkflowInput, emitEventStep, refreshPaymentCollectionForCartWorkflow, releaseLockStep, removeShippingMethodFromCartStep, updateCartPromotionsWorkflow, upsertTaxLinesWorkflow, useQueryGraphStep, useRemoteQueryStep, validateAndReturnShippingMethodsDataStep, validateCartShippingOptionsPriceStep, validateCartShippingOptionsStep, validateCartStep } from "@medusajs/medusa/core-flows"
import { AdditionalData, ShippingOptionDTO } from "@medusajs/types"
import { cartFieldsForRefreshSteps } from "../utils"
import { listSellerShippingOptionsForCartWorkflow } from "./list-seller-shipping-options-for-cart"

type PricedSellerShippingOption = ShippingOptionDTO & {
    calculated_price?: {
        calculated_amount: number
        is_calculated_price_tax_inclusive?: boolean
    } | null
    service_zone?: {
        fulfillment_set?: { location?: Record<string, unknown> | null } | null
    } | null
}

export const addSellerShippingMethodToCartWorkflow = createWorkflow(
    {
        name: "add-seller-shipping-method-to-cart",
    },
    (
        input: WorkflowData<AddShippingMethodToCartWorkflowInput & AdditionalData>
    ) => {
        acquireLockStep({
            key: input.cart_id,
            timeout: 2,
            ttl: 10,
        })

        const cart = useRemoteQueryStep({
            entry_point: "cart",
            fields: cartFieldsForRefreshSteps,
            variables: { id: input.cart_id },
            list: false,
            throw_if_key_not_found: true,
        })

        const allShippingOptionsIds = transform({ input, cart }, (data) => {
            return new Set([...data.input.options.map((option) => option.id), ...data.cart.shipping_methods.map((sm) => sm.shipping_option_id)])
        })

        validateCartStep({ cart })

        const validate = createHook("validate", {
            input,
            cart,
        })

        const optionIds = transform({ input }, (data) => {
            return (data.input.options ?? []).map((i) => i.id)
        })

        // Medusa prices options from the cart's sales channel, which in a
        // marketplace spans every seller's warehouse. The seller-scoped listing
        // starts from the sellers in the cart instead.
        const [allShippingOptions, sellerShippingOptions] = parallelize(
            useQueryGraphStep({
                entity: "shipping_option",
                fields: ['id', 'seller.id'],
                filters: { id: allShippingOptionsIds },
            }).config({
                name: "shipping-options-with-sellers-query",
            }),
            listSellerShippingOptionsForCartWorkflow.runAsStep({
                input: {
                    option_ids: optionIds,
                    cart_id: cart.id,
                    is_return: false,
                    additional_data: input.additional_data,
                },
            })
        )

        const shippingOptions = transform(
            { sellerShippingOptions },
            ({ sellerShippingOptions }) =>
                Object.values(sellerShippingOptions).flat() as PricedSellerShippingOption[]
        )

        validateCartShippingOptionsStep({
            option_ids: optionIds,
            prefetched_shipping_options: shippingOptions,
        })

        validateCartShippingOptionsPriceStep({ shippingOptions })

        const validateShippingMethodsDataInput = transform(
            { input, shippingOptions, cart },
            ({ input, shippingOptions, cart }) => {
                return input.options.map((inputOption) => {
                    const shippingOption = shippingOptions.find(
                        (so) => so.id === inputOption.id
                    )

                    return {
                        id: inputOption.id,
                        provider_id: shippingOption?.provider_id as string,
                        option_data: shippingOption?.data ?? {},
                        method_data: inputOption.data ?? {},
                        context: {
                            ...cart,
                            from_location: shippingOption?.service_zone?.fulfillment_set?.location ?? {},
                        },
                    }
                })
            }
        )

        const validatedMethodData = validateAndReturnShippingMethodsDataStep(
            validateShippingMethodsDataInput
        )

        const shippingMethodInput = transform(
            {
                input,
                shippingOptions,
                validatedMethodData,
            },
            (data) => {
                const options = (data.input.options ?? []).map((option) => {
                    const shippingOption = data.shippingOptions.find(
                        (so) => so.id === option.id
                    )!

                    if (!shippingOption?.calculated_price) {
                        throw new MedusaError(
                            MedusaError.Types.INVALID_DATA,
                            `Shipping option with ID ${shippingOption.id} do not have a price`
                        )
                    }

                    const methodData = data.validatedMethodData?.find((methodData) => {
                        return methodData?.[option.id]
                    })

                    return {
                        shipping_option_id: shippingOption.id,
                        amount: shippingOption.calculated_price.calculated_amount,
                        is_tax_inclusive:
                            !!shippingOption.calculated_price
                                .is_calculated_price_tax_inclusive,
                        data: methodData?.[option.id] ?? {},
                        name: shippingOption.name,
                        cart_id: data.input.cart_id,
                    }
                })

                return options
            }
        )

        const shippingMethodIdsToRemove = transform({ cart, allShippingOptions, input }, ({ cart, allShippingOptions, input }) => {
            const shippingOptionIdsToAdd = input.options.map((option) => option.id)
            const shippingOptionsMap = new Map(allShippingOptions.data.map(so => [so.id, so]))

            const sellerIdsBeingAdded = new Set<string>(
                shippingOptionIdsToAdd
                    .map(id => shippingOptionsMap.get(id)?.seller?.id)
                    .filter(Boolean) as string[]
            )

            return cart.shipping_methods
                .filter(sm => {
                    const shippingOption = shippingOptionsMap.get(sm.shipping_option_id)
                    return shippingOption && sellerIdsBeingAdded.has(shippingOption.seller?.id)
                })
                .map(sm => sm.id)
        })

        const [, createdShippingMethods] = parallelize(
            removeShippingMethodFromCartStep({
                shipping_method_ids: shippingMethodIdsToRemove,
            }),
            addShippingMethodToCartStep({
                shipping_methods: shippingMethodInput,
            })
        )

        // The methods were priced a moment ago, so this skips Medusa's
        // refreshCartItemsWorkflow, which would price every method on the cart
        // a second time, and runs only the refresh steps the new methods need.
        const { data: refetchedCart } = useQueryGraphStep({
            entity: "cart",
            fields: cartFieldsForRefreshSteps,
            filters: { id: cart.id },
            options: { isList: false },
        }).config({ name: "refetch-cart" })

        upsertTaxLinesWorkflow.runAsStep({
            input: transform(
                { refetchedCart, createdShippingMethods },
                ({ refetchedCart, createdShippingMethods }) => ({
                    cart: refetchedCart,
                    items: [],
                    shipping_methods: createdShippingMethods,
                })
            ),
        })

        const cartPromoCodes = transform({ refetchedCart }, ({ refetchedCart }) =>
            (refetchedCart.promotions ?? [])
                .map((promotion) => promotion?.code)
                .filter((code): code is string => Boolean(code))
        )

        updateCartPromotionsWorkflow.runAsStep({
            input: {
                cart_id: cart.id,
                promo_codes: cartPromoCodes,
                action: PromotionActions.REPLACE,
                force_refresh_payment_collection: false,
            },
        })

        refreshPaymentCollectionForCartWorkflow.runAsStep({
            input: { cart: refetchedCart },
        })

        parallelize(
            emitEventStep({
                eventName: CartWorkflowEvents.UPDATED,
                data: { id: input.cart_id },
            }),
            releaseLockStep({
                key: cart.id,
            })
        )

        return new WorkflowResponse(void 0, {
            hooks: [validate],
        })
    }
)
