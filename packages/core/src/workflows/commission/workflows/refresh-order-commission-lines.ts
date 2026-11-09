import {
  WorkflowData,
  WorkflowResponse,
  createHook,
  createWorkflow,
  transform,
  type Hook,
  type ReturnWorkflow,
} from "@medusajs/framework/workflows-sdk"
import {
  CommissionCalculationContext,
  CommissionLineDTO,
} from "@mercurjs/types"

import {
  getCommissionLinesStep,
  resolveCommissionContextsStep,
  upsertCommissionLinesStep,
} from "../steps"

// The order module only decorates totals when a top-level total field such
// as `subtotal` is selected, and derives line totals from the raw columns in
// `items.*` / `shipping_methods.*`, so those stay in the list.
const orderFields = [
  "id",
  "currency_code",
  "subtotal",
  "items.*",
  "items.subtotal",
  "items.tax_total",
  "items.total",
  "items.adjustments.*",
  "items.product.id",
  "items.product.collection_id",
  "items.product.categories.id",
  "items.product.tags.id",
  "items.product.type_id",
  "items.product.attribute_values.id",
  "items.offer.seller_id",
  "shipping_methods.*",
  "shipping_methods.subtotal",
  "shipping_methods.tax_total",
  "shipping_methods.adjustments.*",
]

export type RefreshOrderCommissionLinesWorkflowInput = {
  order_ids: string[]
  /**
   * Calculation contexts the caller already holds (checkout builds them from
   * the cart it just split). When given, the orders are not read again and the
   * lines are created rather than upserted.
   */
  contexts?: CommissionCalculationContext[]
}

export const refreshOrderCommissionLinesWorkflowId = "refresh-order-commission-lines"

// Checkout runs this as a step of a stored workflow; compensating it there needs
// a stored execution of its own, kept as long as checkout keeps its own.
const THREE_DAYS = 3 * 24 * 60 * 60

/**
 * `setCommissionContext` receives the contexts built from the orders. A
 * handler returns `new StepResponse(contexts)` with `additional_context`
 * filled in, or nothing to leave the contexts as they are.
 *
 * `commissionLinesUpserted` runs after the lines are written, inside the same
 * transaction, so a consumer's failure rolls the refresh back.
 */
export type RefreshOrderCommissionLinesWorkflowHooks = [
  Hook<
    "setCommissionContext",
    { contexts: CommissionCalculationContext[] },
    CommissionCalculationContext[] | void
  >,
  Hook<
    "commissionLinesUpserted",
    { order_ids: string[]; commission_lines: CommissionLineDTO[] },
    unknown
  >,
]

export const refreshOrderCommissionLinesWorkflow: ReturnWorkflow<
  RefreshOrderCommissionLinesWorkflowInput,
  CommissionLineDTO[],
  RefreshOrderCommissionLinesWorkflowHooks
> = createWorkflow(
  {
    name: refreshOrderCommissionLinesWorkflowId,
    store: true,
    retentionTime: THREE_DAYS,
  },
  function (
    input: WorkflowData<RefreshOrderCommissionLinesWorkflowInput>
  ) {
    const commissionContexts = resolveCommissionContextsStep({
      order_ids: input.order_ids,
      contexts: input.contexts,
      fields: orderFields,
    })

    const setCommissionContext = createHook("setCommissionContext", {
      contexts: commissionContexts,
    })

    const contexts = transform(
      { commissionContexts, hookResult: setCommissionContext.getResult() },
      ({ commissionContexts, hookResult }): CommissionCalculationContext[] =>
        (hookResult as CommissionCalculationContext[] | undefined) ??
        commissionContexts
    )

    const commissionLines = getCommissionLinesStep(contexts)

    const createOnly = transform({ input }, ({ input }) => !!input.contexts)

    const upsertedCommissionLines = upsertCommissionLinesStep({
      commission_lines: commissionLines,
      create_only: createOnly,
    })

    const commissionLinesUpserted = createHook("commissionLinesUpserted", {
      order_ids: input.order_ids,
      commission_lines: upsertedCommissionLines,
    })

    return new WorkflowResponse(upsertedCommissionLines, {
      hooks: [setCommissionContext, commissionLinesUpserted],
    })
  }
)
