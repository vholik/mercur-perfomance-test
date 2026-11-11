import { check, group, sleep } from "k6"
import http from "k6/http"
import { Counter } from "k6/metrics"

/**
 * Marketplace version of Medusa's mid-sized DTC benchmark:
 * https://github.com/medusajs/medusa/blob/623ee92f32fdd6fdaf29ad1b9755f1e0de492390/scripts/load/mid-sized-dtc-checkout.js
 *
 * Same scenarios, VU split, ramp and think time. Mercur differences:
 * - carts take `offer_id`; the product list returns the cheapest offer per variant
 * - browsing also lists a product's offers (GET /store/offers)
 * - shipping options come back grouped by seller; all sellers' methods are set
 *   in one call, and email/address are set at cart creation
 * - completing a cart returns an order group split into one order per seller
 *
 * Two scenarios Medusa's script has no equivalent for run alongside the
 * storefront ones:
 * - vendorPanel: a seller member logs in, picks their store and walks the
 *   vendor dashboard (orders, products, offers, inventory, payouts)
 * - adminPanel: an operator walks the admin dashboard (orders, order groups,
 *   sellers, products, offers, product changes, payouts)
 *
 *   k6 run perf/k6/mercur-marketplace.js                       # smoke fixtures, full 420 VUs
 *   DATASET=large SCALE=0.05 k6 run perf/k6/mercur-marketplace.js
 *
 * Env: DATASET (fixtures file), SCALE (VU multiplier), RAMP / STEADY (stage
 * durations), ENDPOINT (overrides the fixtures endpoint), CLOUD=1 (k6 cloud),
 * RANDOM_PAGE=1 (spread product pages over the whole catalog; Medusa's script
 * and the default here always read page one), SELLER_PASSWORD (the seed's
 * seller password), ADMIN_EMAIL / ADMIN_PASSWORD (the admin scenario is
 * skipped without them), STORE_ONLY=1 (storefront scenarios only).
 */

const DATASET = __ENV.DATASET || "smoke"
const fixtures = JSON.parse(open(`../fixtures/${DATASET}.json`))

const endpoint = __ENV.ENDPOINT || fixtures.endpoint
const regions = fixtures.regions
const productCount = fixtures.counts.products

const RANDOM_PAGE = __ENV.RANDOM_PAGE === "1"
const SCALE = Number(__ENV.SCALE || 1)
const RAMP = __ENV.RAMP || "2m"
const STEADY = __ENV.STEADY || "6m"

const highVus = Math.max(1, Math.round(300 * SCALE))
const lowVus = Math.max(1, Math.round(30 * SCALE))
// Sellers and operators are far fewer than shoppers: 30 sellers and 10
// operators at the full 420-VU profile.
const vendorVus = Math.max(1, Math.round(30 * SCALE))
const adminVus = Math.max(1, Math.round(10 * SCALE))

const STORE_ONLY = __ENV.STORE_ONLY === "1"
const SELLER_PASSWORD = __ENV.SELLER_PASSWORD || "supersecret"
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD
const withVendor = !STORE_ONLY
const withAdmin = !STORE_ONLY && !!ADMIN_EMAIL && !!ADMIN_PASSWORD
const sellerCount = fixtures.counts.sellers

const promoApplicationRate = 0.1
const minItemsInCart = 3
const maxItemsInCart = 5
const pageSize = 20

const ordersPlaced = new Counter("orders_placed")
const sellersPerOrder = new Counter("order_seller_splits")

const params = {
  headers: {
    "Content-Type": "application/json",
    "x-publishable-api-key": fixtures.publishable_key,
  },
}

const stages = (target) => [
  { duration: RAMP, target },
  { duration: STEADY, target },
  { duration: RAMP, target: 0 },
]

const scenario = (exec, target) => ({
  executor: "ramping-vus",
  exec,
  startTime: "0s",
  stages: stages(target),
  gracefulRampDown: "30s",
  tags: { scenario: exec },
})

export const options = {
  ...(__ENV.CLOUD
    ? {
        cloud: {
          projectID: Number(__ENV.K6_PROJECT_ID),
          name: `Mercur ${DATASET} x${SCALE}`,
          distribution: {
            main: { loadZone: __ENV.LOAD_ZONE || "amazon:de:frankfurt", percent: 100 },
          },
        },
      }
    : {}),
  scenarios: {
    browseCatalog: scenario("browseCatalog", highVus),
    addBrowseAddAbandon: scenario("addBrowseAddAbandon", lowVus),
    addBrowseAddComplete: scenario("addBrowseAddComplete", lowVus),
    addMultipleAbandon: scenario("addMultipleAbandon", lowVus),
    addMultipleComplete: scenario("addMultipleComplete", lowVus),
    ...(withVendor ? { vendorPanel: scenario("vendorPanel", vendorVus) } : {}),
    ...(withAdmin ? { adminPanel: scenario("adminPanel", adminVus) } : {}),
  },
  thresholds: {
    "http_req_duration{scenario:browseCatalog}": ["p(95)<400"],
    "http_req_duration{scenario:addBrowseAddAbandon}": ["p(95)<700"],
    "http_req_duration{scenario:addBrowseAddComplete}": ["p(95)<1200"],
    "http_req_duration{scenario:addMultipleAbandon}": ["p(95)<700"],
    "http_req_duration{scenario:addMultipleComplete}": ["p(95)<1200"],
    ...(withVendor ? { "http_req_duration{scenario:vendorPanel}": ["p(95)<700"] } : {}),
    ...(withAdmin ? { "http_req_duration{scenario:adminPanel}": ["p(95)<700"] } : {}),
    http_req_failed: ["rate<0.01"],
  },
}

export function setup() {
  if (!withAdmin) {
    return {}
  }
  const res = http.post(
    `${endpoint}/auth/user/emailpass`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { "Content-Type": "application/json" } }
  )
  const token = json(res, "token")
  if (!token) {
    throw new Error(`Admin login failed: ${res.status} ${res.body}`)
  }
  return { adminToken: token }
}

// /store/customers/me answers 401 for guests, as in Medusa's script.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 401))

const think = (min = 2, spread = 3) => sleep(min + Math.random() * spread)
const randomItem = (items) => items[Math.floor(Math.random() * items.length)]

function request(method, url, body, name) {
  return http.request(method, url, body ? JSON.stringify(body) : null, {
    ...params,
    tags: { name: name || url },
  })
}

function json(res, key) {
  try {
    return JSON.parse(res.body)[key]
  } catch (_) {
    return undefined
  }
}

function offerIds(products) {
  return products
    .flatMap((p) => p.variants || [])
    .map((v) => v.offer_id)
    .filter(Boolean)
}

const productFields = "*variants.calculated_price,+variants.offer_id"

function listProducts(region) {
  const maxOffset = Math.max(0, productCount - pageSize)
  const offset = RANDOM_PAGE ? Math.floor(Math.random() * (maxOffset + 1)) : 0
  const res = request(
    "GET",
    `${endpoint}/store/products?region_id=${region.id}&fields=${productFields}&limit=${pageSize}&offset=${offset}`,
    null,
    `${endpoint}/store/products?region_id&fields&limit&offset`
  )
  check(res, { "products list ok": (r) => r.status === 200 })
  return json(res, "products") || []
}

export function browseCatalog() {
  return group("Browse Flow", () => {
    const [regionsRes] = http.batch(
      ["regions", "collections", "product-categories", "customers/me"].map(
        (path) => ({
          method: "GET",
          url: `${endpoint}/store/${path}`,
          params: { ...params, tags: { name: `${endpoint}/store/${path}` } },
        })
      )
    )
    check(regionsRes, { "regions ok": (r) => r.status === 200 })
    think()

    const region = randomItem(regions)

    const collections = request("GET", `${endpoint}/store/collections`)
    check(collections, { "collections ok": (r) => r.status === 200 })
    think()

    const products = listProducts(region)
    think()
    if (!products.length) {
      return { region, products }
    }

    const product = randomItem(products)
    const detail = request(
      "GET",
      `${endpoint}/store/products/${product.id}?region_id=${region.id}&fields=${productFields}`,
      null,
      `${endpoint}/store/products/:id`
    )
    check(detail, { "product details ok": (r) => r.status === 200 })
    think()

    const offers = request(
      "GET",
      `${endpoint}/store/offers?product_id=${product.id}&region_id=${region.id}&fields=*calculated_price`,
      null,
      `${endpoint}/store/offers?product_id&region_id`
    )
    check(offers, { "offers list ok": (r) => r.status === 200 })
    think()

    return { region, products }
  })
}

// Email and address go in at creation, while the cart is empty. Setting the
// address later makes Medusa reprice and re-tax every item (force_refresh).
function shippingAddress(region) {
  return {
    first_name: "Load",
    last_name: "Test",
    address_1: "Some street 1",
    company: "ACME",
    postal_code: "13456",
    city: "Wonderland",
    country_code: region.countries[0],
    province: "QC",
    phone: "1234567",
  }
}

function createCart(region) {
  const res = request("POST", `${endpoint}/store/carts`, {
    region_id: region.id,
    email: "load.test@example.com",
    shipping_address: shippingAddress(region),
  })
  check(res, { "create cart ok": (r) => r.status === 200 })
  think()
  return json(res, "cart")
}

function addItemToCart(cartId, offerId, quantity) {
  const res = request(
    "POST",
    `${endpoint}/store/carts/${cartId}/line-items`,
    { offer_id: offerId, quantity },
    `${endpoint}/store/carts/:id/line-items`
  )
  check(res, { "add to cart ok": (r) => r.status === 200 })
  think()
  return json(res, "cart")
}

function viewCart(cartId) {
  const fields =
    "*items,*region,*items.product,*items.variant,*items.thumbnail,*items.metadata,+items.total,*promotions,+shipping_methods.name"
  const res = request(
    "GET",
    `${endpoint}/store/carts/${cartId}?fields=${fields}`,
    null,
    `${endpoint}/store/carts/:id?fields`
  )
  check(res, { "view cart ok": (r) => r.status === 200 })
  think()
}

function applyPromotion(cartId) {
  if (Math.random() >= promoApplicationRate) {
    return
  }
  const res = request(
    "POST",
    `${endpoint}/store/carts/${cartId}/promotions`,
    { promo_codes: [fixtures.promo_code] },
    `${endpoint}/store/carts/:id/promotions`
  )
  check(res, { "add promotion ok": (r) => r.status === 200 })
  think(1, 2)
}

function browseMoreProducts(region) {
  const products = listProducts(region)
  think(3, 4)
  return products
}

function checkout(cartId, region) {
  const [cartRes, providersRes, optionsRes] = http.batch([
    {
      method: "GET",
      url: `${endpoint}/store/carts/${cartId}`,
      params: { ...params, tags: { name: `${endpoint}/store/carts/:id` } },
    },
    {
      method: "GET",
      url: `${endpoint}/store/payment-providers?region_id=${region.id}`,
      params: { ...params, tags: { name: `${endpoint}/store/payment-providers?region_id` } },
    },
    {
      method: "GET",
      url: `${endpoint}/store/shipping-options?cart_id=${cartId}`,
      params: { ...params, tags: { name: `${endpoint}/store/shipping-options?cart_id` } },
    },
  ])
  check(cartRes, { "view cart ok": (r) => r.status === 200 })
  think()

  const regionRes = request(
    "GET",
    `${endpoint}/store/regions/${region.id}`,
    null,
    `${endpoint}/store/regions/:id`
  )
  check(regionRes, { "selected region ok": (r) => r.status === 200 })
  think()

  // Medusa's script updates the address here; ours set it at cart creation,
  // so this stays a plain cart update (same request, no repricing).
  const update = request(
    "POST",
    `${endpoint}/store/carts/${cartId}`,
    { metadata: { checkout_started: true } },
    `${endpoint}/store/carts/:id`
  )
  check(update, { "update cart ok": (r) => r.status === 200 })
  think(0, 3)

  // Mercur groups options by seller and each seller needs a method. One call
  // with every option means one lock and one cart refresh instead of N.
  const optionsBySeller = json(optionsRes, "shipping_options") || {}
  const sellerIds = Object.keys(optionsBySeller)
  if (!sellerIds.length) {
    throw new Error("No shipping options available")
  }
  const methods = request(
    "POST",
    `${endpoint}/store/carts/${cartId}/shipping-methods`,
    sellerIds.map((sellerId) => ({ option_id: optionsBySeller[sellerId][0].id })),
    `${endpoint}/store/carts/:id/shipping-methods`
  )
  check(methods, { "add shipping methods ok": (r) => r.status === 200 })
  think(0, 3)

  const collectionRes = request("POST", `${endpoint}/store/payment-collections`, {
    cart_id: cartId,
  })
  check(collectionRes, { "create payment collection ok": (r) => r.status === 200 })
  think()

  const providers = json(providersRes, "payment_providers") || []
  const provider =
    providers.find((p) => p.id === fixtures.payment_provider_id) || providers[0]
  if (!provider) {
    throw new Error("No payment providers available")
  }

  const collection = json(collectionRes, "payment_collection")
  const sessionRes = request(
    "POST",
    `${endpoint}/store/payment-collections/${collection.id}/payment-sessions`,
    { provider_id: provider.id },
    `${endpoint}/store/payment-collections/:id/payment-sessions`
  )
  check(sessionRes, { "create payment session ok": (r) => r.status === 200 })
  think()

  const completeRes = request(
    "POST",
    `${endpoint}/store/carts/${cartId}/complete`,
    {},
    `${endpoint}/store/carts/:id/complete`
  )
  const placed = check(completeRes, {
    "create order group ok": (r) =>
      r.status === 200 && json(r, "type") === "order_group",
  })
  if (placed) {
    ordersPlaced.add(1)
    sellersPerOrder.add(sellerIds.length)
  }
  think()
}

function addBrowseAdd(complete) {
  const { region, products } = browseCatalog()
  const firstOffers = offerIds(products)
  if (!firstOffers.length) {
    return
  }

  const cart = createCart(region)
  if (!cart) {
    return
  }
  addItemToCart(cart.id, randomItem(firstOffers), 1 + Math.floor(Math.random() * 3))

  const moreOffers = offerIds(browseMoreProducts(region))
  if (!moreOffers.length) {
    return
  }
  addItemToCart(cart.id, randomItem(moreOffers), 1 + Math.floor(Math.random() * 2))

  viewCart(cart.id)
  applyPromotion(cart.id)

  if (complete) {
    checkout(cart.id, region)
  }
}

function addMultiple(complete) {
  const { region, products } = browseCatalog()
  const offers = offerIds(products)
  if (!offers.length) {
    return
  }

  const cart = createCart(region)
  if (!cart) {
    return
  }
  const items =
    minItemsInCart + Math.floor(Math.random() * (maxItemsInCart - minItemsInCart + 1))
  for (let i = 0; i < items; i++) {
    addItemToCart(cart.id, randomItem(offers), 1 + Math.floor(Math.random() * 3))
  }

  viewCart(cart.id)
  applyPromotion(cart.id)

  if (complete) {
    checkout(cart.id, region)
  }
}

export function addBrowseAddAbandon() {
  group("Shop Flow - Add Browse Add Abandon", () => addBrowseAdd(false))
}

export function addBrowseAddComplete() {
  group("Shop Flow - Add Browse Add Complete", () => addBrowseAdd(true))
}

export function addMultipleAbandon() {
  group("Shop Flow - Add Multiple Abandon", () => addMultiple(false))
}

export function addMultipleComplete() {
  group("Shop Flow - Add Multiple Complete", () => addMultiple(true))
}

function authed(token, sellerId) {
  return {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(sellerId ? { "x-seller-id": sellerId } : {}),
    },
  }
}

function panelRequest(session, method, path, body, name) {
  const res = http.request(method, `${endpoint}${path}`, body ? JSON.stringify(body) : null, {
    ...session,
    tags: { name: `${endpoint}${name || path}` },
  })
  check(res, { [`${name || path} ok`]: (r) => r.status === 200 })
  return res
}

function firstId(res, key) {
  const items = json(res, key) || []
  return items.length ? items[0].id : undefined
}

// One login per VU, like a panel tab that stays open. Each VU plays a
// different seller, so the per-seller caches do not hide the list cost.
let vendorSession

function loginSeller() {
  const index = (__VU % sellerCount) + 1
  const email = `perf-seller-${String(index).padStart(4, "0")}@mercur.dev`
  const res = http.post(
    `${endpoint}/auth/member/emailpass`,
    JSON.stringify({ email, password: SELLER_PASSWORD }),
    { headers: { "Content-Type": "application/json" }, tags: { name: `${endpoint}/auth/member/emailpass` } }
  )
  check(res, { "seller login ok": (r) => r.status === 200 })
  const token = json(res, "token")
  if (!token) {
    return undefined
  }

  const stores = http.get(`${endpoint}/vendor/sellers`, {
    ...authed(token),
    tags: { name: `${endpoint}/vendor/sellers` },
  })
  check(stores, { "seller stores ok": (r) => r.status === 200 })
  const members = json(stores, "seller_members") || []
  if (!members.length) {
    return undefined
  }
  return authed(token, members[0].seller_id)
}

export function vendorPanel() {
  group("Vendor Panel", () => {
    if (!vendorSession) {
      vendorSession = loginSeller()
      if (!vendorSession) {
        return
      }
    }
    const s = vendorSession

    panelRequest(s, "GET", "/vendor/sellers/me")
    panelRequest(s, "GET", "/vendor/members/me")
    think()

    const orders = panelRequest(s, "GET", "/vendor/orders?limit=20", null, "/vendor/orders?limit")
    think()
    const orderId = firstId(orders, "orders")
    if (orderId) {
      panelRequest(s, "GET", `/vendor/orders/${orderId}`, null, "/vendor/orders/:id")
      think()
    }

    const products = panelRequest(s, "GET", "/vendor/products?limit=20", null, "/vendor/products?limit")
    think()
    const productId = firstId(products, "products")
    if (productId) {
      panelRequest(s, "GET", `/vendor/products/${productId}`, null, "/vendor/products/:id")
      think()
    }

    const offers = panelRequest(s, "GET", "/vendor/offers?limit=20", null, "/vendor/offers?limit")
    think()
    const offerId = firstId(offers, "offers")
    if (offerId) {
      panelRequest(s, "GET", `/vendor/offers/${offerId}`, null, "/vendor/offers/:id")
      think()
    }

    panelRequest(s, "GET", "/vendor/inventory-items?limit=20", null, "/vendor/inventory-items?limit")
    think()
    panelRequest(s, "GET", "/vendor/payouts?limit=20", null, "/vendor/payouts?limit")
    think(3, 4)
  })
}

export function adminPanel(data) {
  group("Admin Panel", () => {
    const s = authed(data.adminToken)

    const orders = panelRequest(s, "GET", "/admin/orders?limit=20", null, "/admin/orders?limit")
    think()
    const orderId = firstId(orders, "orders")
    if (orderId) {
      panelRequest(s, "GET", `/admin/orders/${orderId}`, null, "/admin/orders/:id")
      think()
    }

    const groups = panelRequest(s, "GET", "/admin/order-groups?limit=20", null, "/admin/order-groups?limit")
    think()
    const groupId = firstId(groups, "order_groups")
    if (groupId) {
      panelRequest(s, "GET", `/admin/order-groups/${groupId}`, null, "/admin/order-groups/:id")
      think()
    }

    const sellers = panelRequest(s, "GET", "/admin/sellers?limit=20", null, "/admin/sellers?limit")
    think()
    const sellerId = firstId(sellers, "sellers")
    if (sellerId) {
      panelRequest(s, "GET", `/admin/sellers/${sellerId}`, null, "/admin/sellers/:id")
      think()
    }

    panelRequest(s, "GET", "/admin/products?limit=20", null, "/admin/products?limit")
    think()
    // The admin offers table groups one row per product and seller.
    panelRequest(s, "GET", "/admin/offers?limit=20&group_by_seller=true", null, "/admin/offers?limit&group_by_seller")
    think()
    panelRequest(s, "GET", "/admin/product-changes?limit=20", null, "/admin/product-changes?limit")
    think()
    panelRequest(s, "GET", "/admin/payouts?limit=20", null, "/admin/payouts?limit")
    think(3, 4)
  })
}
