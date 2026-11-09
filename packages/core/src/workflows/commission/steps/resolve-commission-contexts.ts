import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { CommissionCalculationContext } from "@mercurjs/types"

export type ResolveCommissionContextsStepInput = {
  order_ids: string[]
  contexts?: CommissionCalculationContext[]
  fields: string[]
}

export const resolveCommissionContextsStepId = "resolve-commission-contexts"

// A conditional step rather than `when`: the workflow runs as a step of
// checkout's own `when` block, and the composer does not nest conditions.
export const resolveCommissionContextsStep = createStep(
  resolveCommissionContextsStepId,
  async (
    input: ResolveCommissionContextsStepInput,
    { container }
  ): Promise<StepResponse<CommissionCalculationContext[]>> => {
    if (input.contexts) {
      return new StepResponse(input.contexts)
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: orders } = await query.graph({
      entity: "order",
      fields: input.fields,
      filters: { id: input.order_ids },
    })

    const found = new Set(orders.map((order: { id: string }) => order.id))
    const missing = input.order_ids.find((id) => !found.has(id))
    if (missing) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Order with id: ${missing} was not found`
      )
    }

    const contexts = orders.map((order: any): CommissionCalculationContext => ({
      currency_code: order.currency_code,
      order_id: order.id,
      seller_id: order.items?.[0]?.offer?.seller_id,
      items: (order.items ?? []).map((item: any) => ({
        id: item.id,
        subtotal: item.subtotal,
        tax_total: item.tax_total,
        total: item.total,
        product: item.product
          ? {
              id: item.product.id,
              collection_id: item.product.collection_id,
              categories: item.product.categories,
              tags: item.product.tags,
              type_id: item.product.type_id,
              seller: item.offer?.seller_id
                ? { id: item.offer.seller_id }
                : undefined,
              attribute_value_ids: (item.product.attribute_values ?? []).map(
                (value: { id: string }) => value.id
              ),
            }
          : undefined,
      })),
      shipping_methods: (order.shipping_methods ?? []).map((method: any) => ({
        id: method.id,
        subtotal: method.subtotal,
        tax_total: method.tax_total,
      })),
    }))

    return new StepResponse(contexts)
  }
)
