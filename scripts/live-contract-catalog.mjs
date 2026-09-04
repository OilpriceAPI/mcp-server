// Representative production contracts for every MCP tool. The generated
// matrix is joined to build/capabilities.json, which is produced from the same
// registered server instance used by tools/list. Keep this file declarative so
// CI can prove that every published tool has an explicit live disposition.

const read = (path, shape, entitlement = "conditional") => ({
  mode: "network-read",
  method: "GET",
  path,
  shape,
  entitlement,
});

export const LIVE_CONTRACT_CATALOG = {
  opa_get_product_facts: {
    mode: "non-network",
    classification: "packaged-reviewed-contract",
    reason:
      "The tool reads the packaged, checksum-verified product-facts artifact; its public origin is covered by the separate live product-facts smoke.",
  },
  opa_get_price: read(
    "/v1/prices/latest?by_code=BRENT_CRUDE_USD",
    "success-envelope",
    "ungated",
  ),
  opa_market_overview: read("/v1/prices/all", "success-envelope", "ungated"),
  opa_compare_prices: read(
    "/v1/prices/latest?by_code=WTI_USD",
    "success-envelope",
    "ungated",
  ),
  opa_list_commodities: read("/v1/commodities", "success-envelope", "ungated"),
  opa_get_history: read(
    "/v1/prices/past_week?by_code=BRENT_CRUDE_USD",
    "success-envelope",
  ),
  opa_get_futures: read("/v1/futures/brent", "futures-latest"),
  opa_get_futures_curve: read("/v1/futures/brent/curve", "futures-curve"),
  opa_get_natural_gas_hubs: read(
    "/v1/natural-gas/hubs",
    "success-envelope",
  ),
  opa_get_marine_fuels: read(
    "/v1/marine-fuels/latest",
    "success-envelope",
  ),
  opa_get_rig_counts: read("/v1/rig-counts/latest", "success-envelope"),
  opa_get_drilling: read("/v1/drilling/latest", "success-envelope"),
  opa_get_diesel_by_state: read(
    "/v1/prices/latest?by_code=DIESEL_USD_TX",
    "success-envelope",
  ),
  opa_get_fuel_surcharge: read(
    "/v1/fuel-surcharge",
    "success-envelope",
  ),
  opa_get_storage: read("/v1/storage/cushing", "success-envelope"),
  opa_get_opec_production: read(
    "/v1/ei/opec_productions/latest",
    "success-envelope",
  ),
  opa_get_forecasts: read("/v1/ei/forecasts/latest", "success-envelope"),
  opa_get_oil_inventories: read(
    "/v1/ei/oil_inventories/latest",
    "success-envelope",
  ),
  opa_get_well_permits: read(
    "/v1/ei/well-permits/latest",
    "success-envelope",
  ),
  opa_search_well_permits: read(
    "/v1/ei/well-permits/search?state=TX&limit=1",
    "success-envelope",
  ),
  opa_lookup_well: read(
    "/v1/well-lifecycle/wells/42329447130000",
    "success-envelope",
  ),
  opa_get_well_activity: read(
    "/v1/ei/well-permits/summary?days=30",
    "success-envelope",
  ),
  opa_get_well_production: read(
    "/v1/well-production",
    "success-envelope",
  ),
  opa_get_spread: read("/v1/spreads/crack", "success-envelope"),
  opa_get_account_status: read("/v1/dashboard", "success-envelope", "ungated"),
  opa_get_plans: read("/v1/pricing", "success-envelope", "ungated"),
  opa_get_data_quality: read(
    "/v1/data-quality/summary",
    "success-envelope",
  ),
  opa_get_market_brief: read(
    "/v1/market-brief?codes=BRENT_CRUDE_USD",
    "success-envelope",
    "ungated",
  ),
  opa_list_price_alerts: {
    ...read("/v1/alerts", "array", "ungated"),
    lifecycle: "price-alert",
  },
  opa_get_alert_triggers: {
    ...read("/v1/alerts", "array", "ungated"),
    lifecycle: "price-alert",
  },
  opa_create_price_alert: {
    mode: "network-write",
    method: "POST",
    path: "/v1/alerts",
    lifecycle: "price-alert",
    cleanup: "DELETE /v1/alerts/:id",
  },
  opa_delete_price_alert: {
    mode: "network-write",
    method: "DELETE",
    path: "/v1/alerts/:id",
    lifecycle: "price-alert",
    cleanup: "self",
  },
  opa_list_subscriptions: {
    ...read("/v1/subscriptions", "subscriptions", "ungated"),
    lifecycle: "subscription",
  },
  opa_get_subscription_events: {
    ...read("/v1/subscriptions/events?since=0", "events", "ungated"),
    lifecycle: "subscription",
  },
  opa_create_price_subscription: {
    mode: "network-write",
    method: "POST",
    path: "/v1/subscriptions",
    lifecycle: "subscription",
    cleanup: "DELETE /v1/subscriptions/:id",
  },
  opa_delete_subscription: {
    mode: "network-write",
    method: "DELETE",
    path: "/v1/subscriptions/:id",
    lifecycle: "subscription",
    cleanup: "self",
  },
};
