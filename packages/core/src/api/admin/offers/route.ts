import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, useCache } from "@medusajs/framework/utils"

import { AdminGetOffersParamsType } from "./validators"

export const GET = async (
  req: AuthenticatedMedusaRequest<AdminGetOffersParamsType>,
  res: MedusaResponse
) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const filters = req.filterableFields
  const withDeleted = req.queryConfig.withDeleted || "deleted_at" in filters

  const list = () =>
    query.graph({
      entity: "offer",
      fields: req.queryConfig.fields,
      filters,
      pagination: req.queryConfig.pagination,
      withDeleted,
    })

  // The grouped table counts one row per seller and product, a scan of every
  // offer; a page is held for a minute, and any offer write clears it.
  const { data: offers, metadata } = filters.group_by_seller
    ? await useCache(list, {
        key: ["mercur:admin-offers", filters, req.queryConfig.fields, req.queryConfig.pagination, withDeleted],
        tags: ["Offer:list:*"],
        ttl: 60,
        container: req.scope,
      })
    : await list()

  res.json({
    offers,
    count: metadata?.count ?? 0,
    offset: metadata?.skip ?? 0,
    limit: metadata?.take ?? 0,
  })
}
