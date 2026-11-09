import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AdditionalData, HttpTypes } from "@medusajs/framework/types"
import { refetchCart } from "@medusajs/medusa/api/store/carts/helpers"
import { addSellerShippingMethodToCartWorkflow } from "../../../../../workflows"

export const POST = async (
  req: MedusaRequest<
    HttpTypes.StoreAddCartShippingMethods & AdditionalData
  >,
  res: MedusaResponse<HttpTypes.StoreCartResponse>
) => {
  const payload = req.validatedBody
  const normalizedOptions = Array.isArray(payload) ? payload : [payload]
  // Medusa's validator accepts one option or an array of them; for an array
  // `additional_data` travels on the entries, not on the payload itself.
  const additionalData = (
    normalizedOptions[0] as (AdditionalData & { additional_data?: unknown }) | undefined
  )?.additional_data as AdditionalData["additional_data"]

  await addSellerShippingMethodToCartWorkflow(req.scope).run({
    input: {
      options: normalizedOptions.map((option) => ({
        id: option.option_id,
        data: option.data,
      })),
      cart_id: req.params.id,
      additional_data: additionalData,
    },
  })

  const cart = await refetchCart(
    req.params.id,
    req.scope,
    req.queryConfig.fields
  )

  res.status(200).json({ cart })
}
