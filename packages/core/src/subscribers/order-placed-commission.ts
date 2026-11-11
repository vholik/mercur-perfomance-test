import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { OrderWorkflowEvents } from "@medusajs/framework/utils"

import { refreshOrderCommissionLinesWorkflow } from "../workflows/commission/workflows/refresh-order-commission-lines"

type PlacedOrder = { id?: string }

/**
 * Checkout emits `order.placed` for every seller order of the cart in one
 * event. The commission lines are written here so the shopper's request does
 * not wait for rule matching; payouts read the lines much later.
 */
export default async function orderPlacedCommissionHandler({
  event,
  container,
}: SubscriberArgs<PlacedOrder | PlacedOrder[]>) {
  const orders = Array.isArray(event.data) ? event.data : [event.data]
  const orderIds = orders
    .map((order) => order?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)

  if (!orderIds.length) {
    return
  }

  await refreshOrderCommissionLinesWorkflow(container).run({
    input: { order_ids: orderIds },
  })
}

export const config: SubscriberConfig = {
  event: OrderWorkflowEvents.PLACED,
  context: {
    subscriberId: "order-placed-commission-handler",
  },
}
