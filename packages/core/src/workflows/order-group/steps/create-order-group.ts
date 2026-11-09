import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { CreateOrderGroupDTO, MercurModules, OrderGroupDTO } from "@mercurjs/types"

import SellerModuleService from "../../../modules/seller/service"

// Checkout already looked the cart's group up alongside its other reads and
// passes the answer in, so the step doesn't query the aggregate repository
// again.
type CreateOrderGroupStepInput = CreateOrderGroupDTO & {
  existing_id?: string | null
}

type CreateOrderGroupStepOutput = Pick<
  OrderGroupDTO,
  "id" | "display_id" | "cart_id" | "customer_id"
>

export const createOrderGroupStep = createStep(
  "create-order-group",
  async (
    { existing_id, ...input }: CreateOrderGroupStepInput,
    { container }
  ) => {
    const service = container.resolve<SellerModuleService>(MercurModules.SELLER)

    // A completion interrupted before its orders were created leaves the group
    // behind; reuse it so a retry doesn't create a second one for the cart.
    if (existing_id) {
      const existing = await service.retrieveOrderGroup(existing_id)
      return new StepResponse<CreateOrderGroupStepOutput, string | null>(
        existing,
        null
      )
    }

    const orderGroup = await service.createOrderGroups(input)

    return new StepResponse<CreateOrderGroupStepOutput, string | null>(
      orderGroup,
      orderGroup.id
    )
  },
  async (id: string | null, { container }) => {
    if (!id) {
      return
    }

    const service = container.resolve<SellerModuleService>(MercurModules.SELLER)

    await service.deleteOrderGroups([id])
  }
)
