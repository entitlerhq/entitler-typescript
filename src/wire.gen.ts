/** The API's wire types and routes, generated from openapi.json by scripts/generate.ts. @internal */

export type Actor = { id: string; type: ActorType };
export type ActorType = "ACTOR_TYPE_UNSPECIFIED" | "ACTOR_TYPE_USER" | "ACTOR_TYPE_KEY" | "ACTOR_TYPE_SYSTEM";
export type AddOnSource = { planId: string; planKey: string; planName: string; quantity: number; throughFeatureKey?: string; value?: FeatureValue; versionNumber: number };
export type AdjustMeterRequest = { changeBy?: number; currency?: string; idempotencyKey?: string; reason?: string; setTo?: number; target?: ProductTarget };
export type AdjustMeterResponse = { saturated: boolean; tracked?: TrackedUsage };
export type Amount = { amount: number; currency: string; display: string };
export type AppleListingIds = { productId: string; subscriptionGroupId?: string };
export type AssignmentSource = "ASSIGNMENT_SOURCE_UNSPECIFIED" | "ASSIGNMENT_SOURCE_SERVER" | "ASSIGNMENT_SOURCE_DASHBOARD";
export type AssignTrackRequest = { target?: ProductTarget; trackId?: string };
export type AssignTrackResponse = { assignment?: CustomerTrack; changed: boolean; endedTestHoldings: number };
export type CancelReportRequest = { reason?: string; target?: ProductTarget };
export type CancelReportResponse = { tracked?: TrackedUsage };
export type CheckFeatureResponse = { asOf: number; customer?: EntitledCustomer; entitlement?: Entitlement; nextChangeAt?: number; served?: ServedCatalogue };
export type ConnectionMode = "CONNECTION_MODE_UNSPECIFIED" | "CONNECTION_MODE_LIVE" | "CONNECTION_MODE_TEST";
export type CreateGrantRequest = { currency?: string; days?: number; expectedRevision?: RevisionInput; featureKey?: string; reason?: string; target?: ProductTarget; value?: GrantValue };
export type CreateGrantResponse = { grant?: Grant; revision: number };
export type CreateHoldRequest = { amount?: number; currency?: string; featureKey?: string; idempotencyKey?: string; target?: ProductTarget; ttlSeconds?: number };
export type CreateHoldResponse = { tracked?: TrackedUsage };
export type CreateSnapshotRequest = { lifetimeSeconds?: number; target?: ProductTarget };
export type CreateSnapshotResponse = { expiresAt: number; keyId: string; token: string };
export type CreateTokenRequest = { lifetimeSeconds?: number; scopes?: CustomerTokenScope[]; target?: ProductTarget };
export type CreateTokenResponse = { customerId?: string; expiresAt: number; scopes: CustomerTokenScope[]; token: string; tokenId: string };
export type Customer = { attributes: CustomerAttribute[]; createdAt: number; email?: string; environmentId: string; externalId: string; id: string; identityProviderId?: string; marketId?: string; money: CustomerMoney; name?: string; projectId: string; revision: number; trackId?: string; updatedAt: number };
export type CustomerAttribute = { key: string; value: string };
export type CustomerAttributeChange = { key?: string; value?: string };
export type CustomerLineDiscount = { amount?: Amount; offerId: string; offerKey: string; offerName: string };
export type CustomerMoney = "CUSTOMER_MONEY_UNSPECIFIED" | "CUSTOMER_MONEY_REAL" | "CUSTOMER_MONEY_TEST";
export type CustomerPriceLine = { discounts: CustomerLineDiscount[]; listPrice?: Amount; periodId?: string; planId: string; price?: Amount; quantity: number; state: PlanPriceState; unitPrice?: Amount; version: number };
export type CustomerPriceLines = { lines: CustomerPriceLine[] };
export type CustomerPrices = { market?: PricingMarket; subscriptions: SubscriptionPrice[] };
export type CustomerTokenScope = "CUSTOMER_TOKEN_SCOPE_UNSPECIFIED" | "CUSTOMER_TOKEN_SCOPE_ENTITLEMENTS_READ" | "CUSTOMER_TOKEN_SCOPE_USAGE_READ" | "CUSTOMER_TOKEN_SCOPE_USAGE_WRITE" | "CUSTOMER_TOKEN_SCOPE_BILLING_SELF";
export type CustomerTrack = { customerId: string; externalId: string; money: CustomerMoney; previousTrackId?: string; revision: number; source: AssignmentSource; trackId?: string };
export type DefaultPlanSource = { planId: string; planKey: string; planName: string; productId?: string; throughFeatureKey?: string; versionNumber: number };
export type EntitledCustomer = { customerId?: string; externalId: string };
export type EntitledFeatureKind = "ENTITLED_FEATURE_KIND_UNSPECIFIED" | "ENTITLED_FEATURE_KIND_SWITCH" | "ENTITLED_FEATURE_KIND_METERED" | "ENTITLED_FEATURE_KIND_CONFIGURATION" | "ENTITLED_FEATURE_KIND_GROUP";
export type Entitlement = { currency: string; decimals: number; entitled: boolean; featureKey: string; kind: EntitledFeatureKind; meter?: Meter; sources: EntitlementSource[]; upgrades: Upgrade[]; value?: FeatureValue };
export type EntitlementSource = { addOn?: AddOnSource; defaultPlan?: DefaultPlanSource; grant?: GrantSource; group?: GroupSource; plan?: PlanSource };
export type EraseCustomerRequest = { target?: ProductTarget };
export type EraseCustomerResponse = { erased: number };
export type EveryMonths = { firstAfterMonths: number; months: number };
export type FeatureValue = { configuration?: Limit; group?: GroupValue; metered?: Limit; money?: MarketLimits; switch?: boolean };
export type FeeDirection = "FEE_DIRECTION_UNSPECIFIED" | "FEE_DIRECTION_DEBIT" | "FEE_DIRECTION_CREDIT";
export type FeeSchedule = { everyMonths?: EveryMonths; onPurchase?: OnPurchase; yearlyOn?: YearlyOn };
export type GetCustomerPricingResponse = { prices?: CustomerPrices; pricing?: PricingSheet };
export type GetCustomerResponse = { customer?: Customer };
export type GetPricingResponse = { pricing?: PricingSheet };
export type GoogleListingIds = { basePlanId?: string; offerId?: string; productId: string; purchaseOptionId?: string };
export type Grant = { featureKey: string; from: number; grantedBy?: Actor; id: string; reason: string; revokeReason?: string; revokedAt?: number; revokedBy?: Actor; until?: number; value?: GrantValue };
export type GrantSource = { grantId: string; throughFeatureKey?: string; until?: number; value?: FeatureValue };
export type GrantValue = { limit?: Limit; on?: SwitchOn };
export type GroupMember = { configuration?: Limit; featureKey: string; group?: GroupValue; metered?: Limit; switch?: boolean };
export type GroupSource = { featureKeys: string[] };
export type GroupValue = { members: GroupMember[] };
export type Limit = { count?: number; unlimited?: Unlimited };
export type ListEntitlementsResponse = { asOf: number; customer?: EntitledCustomer; entitlements: Entitlement[]; nextChangeAt?: number; served?: ServedCatalogue };
export type ListingIds = { apple?: AppleListingIds; google?: GoogleListingIds; stripe?: StripeListingIds };
export type ListingPrice = { amount: number; currency: string; interval: ListingPriceInterval; intervalCount: number; tax: ListingTaxBehaviour };
export type ListingPriceInterval = "LISTING_PRICE_INTERVAL_UNSPECIFIED" | "LISTING_PRICE_INTERVAL_DAY" | "LISTING_PRICE_INTERVAL_WEEK" | "LISTING_PRICE_INTERVAL_MONTH" | "LISTING_PRICE_INTERVAL_YEAR";
export type ListingTaxBehaviour = "LISTING_TAX_BEHAVIOUR_UNSPECIFIED" | "LISTING_TAX_BEHAVIOUR_INCLUSIVE" | "LISTING_TAX_BEHAVIOUR_EXCLUSIVE";
export type MarketLimit = { limit?: Limit; marketId: string };
export type MarketLimits = { limits: MarketLimit[] };
export type MarketTax = "MARKET_TAX_UNSPECIFIED" | "MARKET_TAX_INCLUDED" | "MARKET_TAX_ADDED";
export type Meter = { banked: number; held: number; remaining?: Limit; resetsAt?: number; used: number };
export type NextCharge = { amount?: Amount; at: number; direction: FeeDirection; feeKey: string };
export type NothingServed = Record<string, never>;
export type OnPurchase = Record<string, never>;
export type PaymentProvider = "PAYMENT_PROVIDER_UNSPECIFIED" | "PAYMENT_PROVIDER_STRIPE" | "PAYMENT_PROVIDER_APPLE" | "PAYMENT_PROVIDER_GOOGLE";
export type PeriodPrice = { bands: PricedBand[]; periodId?: string; price?: Amount };
export type PeriodUnit = "PERIOD_UNIT_UNSPECIFIED" | "PERIOD_UNIT_DAYS" | "PERIOD_UNIT_WEEKS" | "PERIOD_UNIT_MONTHS";
export type PlanItem = { bank?: Limit; benefitThousandths?: number; featureKey: string; value?: FeatureValue };
export type PlanKind = "PLAN_KIND_UNSPECIFIED" | "PLAN_KIND_PLAN" | "PLAN_KIND_ADD_ON";
export type PlanListing = { channels: PricedChannel[]; periodId?: string };
export type PlanPriceState = "PLAN_PRICE_STATE_UNSPECIFIED" | "PLAN_PRICE_STATE_FREE" | "PLAN_PRICE_STATE_PRICED" | "PLAN_PRICE_STATE_NOT_PRICED";
export type PlanSource = { planId: string; planKey: string; planName: string; productId?: string; throughFeatureKey?: string; value?: FeatureValue; versionNumber: number };
export type PlanStatus = "PLAN_STATUS_UNSPECIFIED" | "PLAN_STATUS_ACTIVE" | "PLAN_STATUS_LEGACY" | "PLAN_STATUS_ARCHIVED";
export type PricedBand = { amount?: Amount; perUnit: boolean; upTo?: number };
export type PricedChannel = { connectionId: string; ids?: ListingIds; mode: ConnectionMode; name: string; price?: ListingPrice; provider: PaymentProvider; purchasable: boolean };
export type PricedFee = { direction: FeeDirection; key: string; name: string; price?: Amount; schedule?: FeeSchedule };
export type PricedPeriod = { count: number; id: string; key: string; label: string; unit: PeriodUnit };
export type PricedPlan = { availableOn: string[]; byDefault: boolean; description: string; fees: PricedFee[]; id: string; items: PlanItem[]; key: string; kind: PlanKind; listings: PlanListing[]; name: string; periods: PricedPeriod[]; priceState: PlanPriceState; prices: PeriodPrice[]; productId?: string; quantity?: QuantityRule; salesLed: boolean; status: PlanStatus; trial?: TrialLength; versionNumber: number };
export type PricedProduct = { defaultPlanId?: string; id: string; key: string; name: string };
export type PricingMarket = { currency: string; id: string; key: string; name: string; tax: MarketTax };
export type PricingSheet = { customer?: string; market?: PricingMarket; plans: PricedPlan[]; products: PricedProduct[]; served?: ServedCatalogue; testers: boolean };
export type ProductTarget = { environmentId?: string; projectId?: string; teamId?: string };
export type QuantityRule = { max?: number; min: number };
export type RegisterCustomerRequest = { attributes?: CustomerAttributeChange[]; email?: string; name?: string; target?: ProductTarget; visitorId?: string };
export type RegisterCustomerResponse = { created: boolean; customer?: Customer };
export type ReleaseHoldResponse = { tracked?: TrackedUsage };
export type ReportUsageRequest = { amount?: number; currency?: string; featureKey?: string; idempotencyKey?: string; mode?: UsageMode; occurredAtMs?: number; register?: boolean; target?: ProductTarget };
export type ReportUsageResponse = { tracked?: TrackedUsage };
export type RevisionInput = { value?: number };
export type RevokeGrantRequest = { expectedRevision?: RevisionInput; reason?: string; target?: ProductTarget };
export type RevokeGrantResponse = { changed: boolean; grant?: Grant; revision: number };
export type ServedCatalogue = { changeId?: string; nothing?: NothingServed; release?: ServedRelease; track?: ServedTrack };
export type ServedRelease = { id: string; number: number };
export type ServedTrack = { id: string; name: string };
export type SettleHoldRequest = { amount?: number; target?: ProductTarget };
export type SettleHoldResponse = { tracked?: TrackedUsage };
export type SnapshotKeySet = { keys: { alg: "ES256"; crv: "P-256"; kid: string; kty: "EC"; use: "sig"; x: string; y: string }[] };
export type StripeListingIds = { priceId: string };
export type SubscriptionPrice = { atRenewal?: CustomerPriceLines; nextCharges: NextCharge[]; now: CustomerPriceLine[]; productId?: string; renewsAt: number; subscriptionId: string };
export type SwitchOn = Record<string, never>;
export type TrackedUsage = { asOf: number; customer?: EntitledCustomer; entitlement?: Entitlement; served?: ServedCatalogue; usage?: UsageResult };
export type TrialLength = { days?: number; months?: number };
export type Unlimited = Record<string, never>;
export type UpdateCustomerRequest = { attributes?: CustomerAttributeChange[]; email?: string; expectedRevision?: RevisionInput; name?: string; target?: ProductTarget };
export type UpdateCustomerResponse = { customer?: Customer };
export type Upgrade = { action: UpgradeAction; kind: UpgradeKind; move: UpgradeMove; planId: string; planKey: string; planName: string; productId?: string };
export type UpgradeAction = "UPGRADE_ACTION_UNSPECIFIED" | "UPGRADE_ACTION_BUY" | "UPGRADE_ACTION_CONTACT";
export type UpgradeKind = "UPGRADE_KIND_UNSPECIFIED" | "UPGRADE_KIND_PLAN" | "UPGRADE_KIND_ADD_ON";
export type UpgradeMove = "UPGRADE_MOVE_UNSPECIFIED" | "UPGRADE_MOVE_SUBSCRIBE" | "UPGRADE_MOVE_UPGRADE" | "UPGRADE_MOVE_SWITCH" | "UPGRADE_MOVE_ADD" | "UPGRADE_MOVE_REPLACE";
export type UsageMode = "USAGE_MODE_UNSPECIFIED" | "USAGE_MODE_GATE" | "USAGE_MODE_OBSERVE";
export type UsageOutcome = "USAGE_OUTCOME_UNSPECIFIED" | "USAGE_OUTCOME_RECORDED" | "USAGE_OUTCOME_REFUSED" | "USAGE_OUTCOME_DUPLICATE" | "USAGE_OUTCOME_CANCELLED" | "USAGE_OUTCOME_HELD" | "USAGE_OUTCOME_SETTLED" | "USAGE_OUTCOME_RELEASED" | "USAGE_OUTCOME_ADJUSTED";
export type UsageRefusal = "USAGE_REFUSAL_UNSPECIFIED" | "USAGE_REFUSAL_NOT_ENTITLED" | "USAGE_REFUSAL_OVER_ALLOWANCE";
export type UsageResult = { amount: number; expiresAtMs?: number; holdId?: string; late: boolean; meterChange: number; mode: UsageMode; occurredAtMs?: number; outcome: UsageOutcome; overBy: number; refusal?: UsageRefusal; replayed: boolean; saturated: boolean; usageId?: string };
export type YearlyDate = { day: number; month: number };
export type YearlyOn = { dates: YearlyDate[] };

export const ROUTES = {
  "CustomerTokens.CreateToken": { method: "POST", path: "/v1/customers/{external_id}/tokens", query: [] },
  "CustomerTracks.AssignTrack": { method: "PUT", path: "/v1/customers/{external_id}/track", query: [] },
  "Customers.EraseCustomer": { method: "POST", path: "/v1/customers/{external_id}:erase", query: [] },
  "Customers.GetCustomer": { method: "GET", path: "/v1/customers/{external_id}", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Customers.RegisterCustomer": { method: "PUT", path: "/v1/customers/{external_id}", query: [] },
  "Customers.UpdateCustomer": { method: "PATCH", path: "/v1/customers/{external_id}", query: [] },
  "Entitlements.CheckFeature": { method: "GET", path: "/v1/customers/{external_id}/entitlements/{feature_key}", query: ["target.team_id","target.project_id","target.environment_id","as_of"] },
  "Entitlements.ListEntitlements": { method: "GET", path: "/v1/customers/{external_id}/entitlements", query: ["target.team_id","target.project_id","target.environment_id","as_of"] },
  "Grants.CreateGrant": { method: "POST", path: "/v1/customers/{external_id}/grants", query: [] },
  "Grants.RevokeGrant": { method: "POST", path: "/v1/customers/{external_id}/grants/{grant_id}:revoke", query: [] },
  "Pricing.GetCustomerPricing": { method: "GET", path: "/v1/customers/{external_id}/pricing", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Pricing.GetPricing": { method: "GET", path: "/v1/pricing", query: ["target.team_id","target.project_id","target.environment_id","market","country"] },
  "SnapshotKeys": { method: "GET", path: "/v1/snapshot-keys", query: [] },
  "Snapshots.CreateSnapshot": { method: "POST", path: "/v1/customers/{external_id}/snapshots", query: [] },
  "Usage.AdjustMeter": { method: "POST", path: "/v1/customers/{external_id}/meters/{feature_key}:adjust", query: [] },
  "Usage.CancelReport": { method: "POST", path: "/v1/customers/{external_id}/usage/{usage_id}:cancel", query: [] },
  "Usage.CreateHold": { method: "POST", path: "/v1/customers/{external_id}/usage/holds", query: [] },
  "Usage.ReleaseHold": { method: "DELETE", path: "/v1/customers/{external_id}/usage/holds/{hold_id}", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Usage.ReportUsage": { method: "POST", path: "/v1/customers/{external_id}/usage", query: [] },
  "Usage.SettleHold": { method: "POST", path: "/v1/customers/{external_id}/usage/holds/{hold_id}:settle", query: [] },
} as const;
