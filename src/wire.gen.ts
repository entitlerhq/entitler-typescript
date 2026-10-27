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
export type BilledPlan = { billingConnectionId?: string; cohortId?: string; periodId?: string; planId: string; since: number; versionNumber: number };
export type BilledProduct = { connectionId: string; drift?: BillingDrift; items: number; productId?: string; renews: boolean; sku?: BilledSku; status: ProviderSubscriptionStatus };
export type BilledSku = { periodId?: string; price?: ListingPrice; priceId: string };
export type BillingDrift = { billedPlanId: string; heldPlanId?: string; observedAt: number; productId?: string };
export type BillingPeriodReset = Record<string, never>;
export type Cancellation = { chargedBack?: Amount; endsAt: number; exitFee?: Amount };
export type CancelPendingAddOnChangeRequest = { asOf?: number; expectedRevision?: RevisionInput; reason?: string; target?: ProductTarget };
export type CancelPendingAddOnChangeResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type CancelPendingChangeRequest = { asOf?: number; expectedRevision?: RevisionInput; productId?: string; reason?: string; target?: ProductTarget };
export type CancelPendingChangeResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type CancelReportRequest = { reason?: string; target?: ProductTarget };
export type CancelReportResponse = { tracked?: TrackedUsage };
export type CancelSubscriptionRequest = { asOf?: number; endsAt?: number; expectedRevision?: RevisionInput; productId?: string; reason?: string; target?: ProductTarget };
export type CancelSubscriptionResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type CheckFeatureResponse = { asOf: number; customer?: EntitledCustomer; entitlement?: Entitlement; nextChangeAt?: number; served?: ServedCatalogue };
export type ChooseSubscriptionRequest = { asOf?: number; country?: string; expectedRevision?: RevisionInput; market?: string; offer?: OfferTaken; periodId?: string; plan?: PlanSelector; quantity?: number; reason?: string; register?: boolean; returnUrl?: string; target?: ProductTarget };
export type ChooseSubscriptionResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type ConnectionMode = "CONNECTION_MODE_UNSPECIFIED" | "CONNECTION_MODE_LIVE" | "CONNECTION_MODE_TEST";
export type CreateGrantRequest = { currency?: string; days?: number; expectedRevision?: RevisionInput; featureKey?: string; reason?: string; target?: ProductTarget; value?: GrantValue };
export type CreateGrantResponse = { grant?: Grant; revision: number };
export type CreateHoldRequest = { amount?: number; currency?: string; featureKey?: string; idempotencyKey?: string; target?: ProductTarget; ttlSeconds?: number };
export type CreateHoldResponse = { tracked?: TrackedUsage };
export type CreatePortalSessionRequest = { returnUrl?: string; target?: ProductTarget };
export type CreatePortalSessionResponse = { url: string };
export type CreateSnapshotRequest = { lifetimeSeconds?: number; target?: ProductTarget };
export type CreateSnapshotResponse = { expiresAt: number; keyId: string; token: string };
export type CreateTokenRequest = { lifetimeSeconds?: number; scopes?: CustomerTokenScope[]; target?: ProductTarget };
export type CreateTokenResponse = { customerId?: string; expiresAt: number; scopes: CustomerTokenScope[]; token: string; tokenId: string };
export type Customer = { attributes: CustomerAttribute[]; createdAt: number; email?: string; environmentId: string; externalId: string; id: string; identityProviderId?: string; marketId?: string; money: CustomerMoney; name?: string; projectId: string; revision: number; trackId?: string; updatedAt: number };
export type CustomerAttribute = { key: string; value: string };
export type CustomerAttributeChange = { key?: string; value?: string };
export type CustomerBilling = { connectionId?: string; drift?: BillingDrift; items: number; linked: boolean; products: BilledProduct[]; renews: boolean; sku?: BilledSku; status: ProviderSubscriptionStatus };
export type CustomerLineDiscount = { amount?: Amount; offerId: string; offerKey: string; offerName: string };
export type CustomerMoney = "CUSTOMER_MONEY_UNSPECIFIED" | "CUSTOMER_MONEY_REAL" | "CUSTOMER_MONEY_TEST";
export type CustomerPriceLine = { discounts: CustomerLineDiscount[]; listPrice?: Amount; periodId?: string; planId: string; price?: Amount; quantity: number; state: PlanPriceState; unitPrice?: Amount; version: number };
export type CustomerPriceLines = { lines: CustomerPriceLine[] };
export type CustomerPrices = { market?: PricingMarket; subscriptions: SubscriptionPrice[] };
export type CustomerTokenScope = "CUSTOMER_TOKEN_SCOPE_UNSPECIFIED" | "CUSTOMER_TOKEN_SCOPE_ENTITLEMENTS_READ" | "CUSTOMER_TOKEN_SCOPE_USAGE_READ" | "CUSTOMER_TOKEN_SCOPE_USAGE_WRITE" | "CUSTOMER_TOKEN_SCOPE_BILLING_SELF";
export type CustomerTrack = { customerId: string; externalId: string; money: CustomerMoney; previousTrackId?: string; revision: number; source: AssignmentSource; trackId?: string };
export type DefaultPlanSource = { planId: string; planKey: string; planName: string; productId?: string; throughFeatureKey?: string; versionNumber: number };
export type DeviceAtLimit = "DEVICE_AT_LIMIT_UNSPECIFIED" | "DEVICE_AT_LIMIT_REFUSE" | "DEVICE_AT_LIMIT_END_OLDEST";
export type DeviceLimit = { atLimit: DeviceAtLimit; kind: DeviceLimitKind; lockoutMinutes: number[]; lockoutQuietDays?: number };
export type DeviceLimitKind = "DEVICE_LIMIT_KIND_UNSPECIFIED" | "DEVICE_LIMIT_KIND_SIGNED_IN" | "DEVICE_LIMIT_KIND_IN_USE";
export type DiscountGivenBy = "DISCOUNT_GIVEN_BY_UNSPECIFIED" | "DISCOUNT_GIVEN_BY_BUSINESS" | "DISCOUNT_GIVEN_BY_CUSTOMER" | "DISCOUNT_GIVEN_BY_CODE";
export type Effective = "EFFECTIVE_UNSPECIFIED" | "EFFECTIVE_NOW" | "EFFECTIVE_RENEWAL";
export type EndProduct = { productId?: string };
export type EntitledCustomer = { customerId?: string; externalId: string };
export type EntitledFeatureKind = "ENTITLED_FEATURE_KIND_UNSPECIFIED" | "ENTITLED_FEATURE_KIND_SWITCH" | "ENTITLED_FEATURE_KIND_METERED" | "ENTITLED_FEATURE_KIND_CONFIGURATION" | "ENTITLED_FEATURE_KIND_GROUP";
export type Entitlement = { currency: string; decimals: number; entitled: boolean; featureKey: string; kind: EntitledFeatureKind; meter?: Meter; sources: EntitlementSource[]; upgrades: Upgrade[]; value?: FeatureValue };
export type EntitlementSource = { addOn?: AddOnSource; defaultPlan?: DefaultPlanSource; grant?: GrantSource; group?: GroupSource; plan?: PlanSource };
export type EraseCustomerRequest = { target?: ProductTarget };
export type EraseCustomerResponse = { erased: number };
export type EveryMonths = { firstAfterMonths: number; months: number };
export type Feature = { archived: boolean; id: string; key: string; kind: FeatureKind; version?: FeatureVersion };
export type FeatureImpact = { featureKey: string; from?: FeatureValue; kind: ImpactKind; to?: FeatureValue };
export type FeatureKind = "FEATURE_KIND_UNSPECIFIED" | "FEATURE_KIND_SWITCH" | "FEATURE_KIND_METERED" | "FEATURE_KIND_CONFIGURATION" | "FEATURE_KIND_GROUP";
export type FeatureValue = { configuration?: Limit; group?: GroupValue; metered?: Limit; money?: MarketLimits; switch?: boolean };
export type FeatureVersion = { changeId?: string; description: string; deviceLimit?: DeviceLimit; lateDays?: number; measure?: Measure; members?: GroupValue; name: string; number: number; reset?: MeterReset; rounding?: Rounding; sharesLimit: boolean; unit: string; zones: Zone[] };
export type FeeDirection = "FEE_DIRECTION_UNSPECIFIED" | "FEE_DIRECTION_DEBIT" | "FEE_DIRECTION_CREDIT";
export type FeeSchedule = { everyMonths?: EveryMonths; onPurchase?: OnPurchase; yearlyOn?: YearlyOn };
export type GetBillingResponse = { billing?: CustomerBilling };
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
export type HeldAddOn = { addedAt: number; billingConnectionId?: string; cohortId?: string; cohortNumber?: number; lockedUntil?: number; money: CustomerMoney; movingToPlanId?: string; planId: string; planKey: string; planName: string; purchaseSource?: string; quantity: number; required: boolean; versionNumber: number };
export type HeldDiscount = { amount?: Amount; applied: boolean; fees: OfferFee[]; givenAt: number; givenBy: DiscountGivenBy; minimumStayMonths?: number; offerId: string; offerKey: string; offerName: string; percentThousandths?: number; periodIds: string[]; periodsLeft?: number; planIds: string[]; startsAt?: number; until?: number };
export type HeldPlan = { billingConnectionId?: string; byDefault: boolean; cohortId?: string; cohortNumber?: number; lockedUntil?: number; money: CustomerMoney; periodId?: string; planId: string; planKey: string; planName: string; purchaseSource?: string; versionNumber: number };
export type HeldTerm = { endsAt: number; then: TermThen };
export type Holdings = { grants: Grant[]; lanes: LaneHolding[] };
export type ImpactKind = "IMPACT_KIND_UNSPECIFIED" | "IMPACT_KIND_GAINS" | "IMPACT_KIND_LOSES" | "IMPACT_KIND_CHANGES";
export type LaneHolding = { addOns: HeldAddOn[]; billed?: BilledPlan; cancellation?: Cancellation; cancelsAt?: number; collection: SubscriptionCollection; contractStartedAt?: number; discounts: HeldDiscount[]; paidUntil?: number; paymentAmount?: Amount; paymentDays?: number; paymentDueAt?: number; pending?: PendingChange; periodsAhead: number; plan?: HeldPlan; productId?: string; renewsAt?: number; scheduledChanges: ScheduledChange[]; startedAt?: number; term?: HeldTerm; trialEndsAt?: number; until?: number };
export type Limit = { count?: number; unlimited?: Unlimited };
export type ListAvailablePlansResponse = { asOf: number; customerId?: string; holdings?: Holdings; options: PlanOption[] };
export type ListEntitlementsResponse = { asOf: number; customer?: EntitledCustomer; entitlements: Entitlement[]; nextChangeAt?: number; served?: ServedCatalogue };
export type ListFeaturesOnSaleResponse = { features: Feature[]; served?: ServedCatalogue };
export type ListingIds = { apple?: AppleListingIds; google?: GoogleListingIds; stripe?: StripeListingIds };
export type ListingPrice = { amount: number; currency: string; interval: ListingPriceInterval; intervalCount: number; tax: ListingTaxBehaviour };
export type ListingPriceInterval = "LISTING_PRICE_INTERVAL_UNSPECIFIED" | "LISTING_PRICE_INTERVAL_DAY" | "LISTING_PRICE_INTERVAL_WEEK" | "LISTING_PRICE_INTERVAL_MONTH" | "LISTING_PRICE_INTERVAL_YEAR";
export type ListingTaxBehaviour = "LISTING_TAX_BEHAVIOUR_UNSPECIFIED" | "LISTING_TAX_BEHAVIOUR_INCLUSIVE" | "LISTING_TAX_BEHAVIOUR_EXCLUSIVE";
export type MarketLimit = { limit?: Limit; marketId: string };
export type MarketLimits = { limits: MarketLimit[] };
export type MarketTax = "MARKET_TAX_UNSPECIFIED" | "MARKET_TAX_INCLUDED" | "MARKET_TAX_ADDED";
export type Measure = { decimals?: number; money?: Money };
export type Meter = { banked: number; held: number; remaining?: Limit; resetsAt?: number; used: number };
export type MeterReset = { billingPeriod?: BillingPeriodReset; window?: MeterWindow };
export type MeterWindow = { anchor: WindowAnchor; count: number; unit: WindowUnit };
export type Money = Record<string, never>;
export type MoveResult = { change?: PlanChange; customerId: string; holdings?: Holdings; money: CustomerMoney; revision: number };
export type MoveTiming = "MOVE_TIMING_UNSPECIFIED" | "MOVE_TIMING_NOW_KEEP" | "MOVE_TIMING_NOW_NEW" | "MOVE_TIMING_PERIOD_END";
export type NextCharge = { amount?: Amount; at: number; direction: FeeDirection; feeKey: string };
export type NothingServed = Record<string, never>;
export type OfferChoice = { offerKey?: string; value?: OfferValue };
export type OfferFee = { feeKey: string; planId: string };
export type OfferTaken = { code?: string; offerKey?: string };
export type OfferValue = { amount?: number; percentThousandths?: number };
export type OnPurchase = Record<string, never>;
export type OptionKind = "OPTION_KIND_UNSPECIFIED" | "OPTION_KIND_SUBSCRIBE" | "OPTION_KIND_MOVE" | "OPTION_KIND_ADD" | "OPTION_KIND_REPLACE";
export type PaymentConfirming = Record<string, never>;
export type PaymentProvider = "PAYMENT_PROVIDER_UNSPECIFIED" | "PAYMENT_PROVIDER_STRIPE" | "PAYMENT_PROVIDER_APPLE" | "PAYMENT_PROVIDER_GOOGLE";
export type PaymentStep = { status: PaymentStepStatus; url: string };
export type PaymentStepStatus = "PAYMENT_STEP_STATUS_UNSPECIFIED" | "PAYMENT_STEP_STATUS_CHECKOUT" | "PAYMENT_STEP_STATUS_CONFIRMATION" | "PAYMENT_STEP_STATUS_REQUIRES_ACTION" | "PAYMENT_STEP_STATUS_DECLINED" | "PAYMENT_STEP_STATUS_PENDING";
export type PendingCancel = Record<string, never>;
export type PendingChange = { at: number; cancel?: PendingCancel; move?: PendingPlanMove };
export type PendingPlanMove = { periodId?: string; planId: string; until?: number };
export type PeriodPrice = { bands: PricedBand[]; periodId?: string; price?: Amount };
export type PeriodUnit = "PERIOD_UNIT_UNSPECIFIED" | "PERIOD_UNIT_DAYS" | "PERIOD_UNIT_WEEKS" | "PERIOD_UNIT_MONTHS";
export type PlanChange = { at: number; changed: boolean; effective: Effective; plan?: HeldPlan; policy: SubscriptionMovePolicy; productId?: string; quantity?: number; until?: number };
export type PlanDirection = "PLAN_DIRECTION_UNSPECIFIED" | "PLAN_DIRECTION_UP" | "PLAN_DIRECTION_CROSS" | "PLAN_DIRECTION_DOWN";
export type PlanItem = { bank?: Limit; benefitThousandths?: number; featureKey: string; value?: FeatureValue };
export type PlanKind = "PLAN_KIND_UNSPECIFIED" | "PLAN_KIND_PLAN" | "PLAN_KIND_ADD_ON";
export type PlanListing = { channels: PricedChannel[]; periodId?: string };
export type PlanOption = { direction: PlanDirection; impact: FeatureImpact[]; kind: OptionKind; periodIds: string[]; planId: string; planKey: string; planName: string; productId?: string; replacesPlanId?: string; selling: Selling; timing: MoveTiming };
export type PlanPriceState = "PLAN_PRICE_STATE_UNSPECIFIED" | "PLAN_PRICE_STATE_FREE" | "PLAN_PRICE_STATE_PRICED" | "PLAN_PRICE_STATE_NOT_PRICED";
export type PlanSelector = { planId?: string; planKey?: string };
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
export type ProviderSubscriptionStatus = "PROVIDER_SUBSCRIPTION_STATUS_UNSPECIFIED" | "PROVIDER_SUBSCRIPTION_STATUS_ACTIVE" | "PROVIDER_SUBSCRIPTION_STATUS_TRIALING" | "PROVIDER_SUBSCRIPTION_STATUS_PAST_DUE" | "PROVIDER_SUBSCRIPTION_STATUS_INCOMPLETE" | "PROVIDER_SUBSCRIPTION_STATUS_INCOMPLETE_EXPIRED" | "PROVIDER_SUBSCRIPTION_STATUS_CANCELED" | "PROVIDER_SUBSCRIPTION_STATUS_UNPAID" | "PROVIDER_SUBSCRIPTION_STATUS_PAUSED";
export type QuantityRule = { max?: number; min: number };
export type RegisterCustomerRequest = { attributes?: CustomerAttributeChange[]; email?: string; name?: string; target?: ProductTarget; visitorId?: string };
export type RegisterCustomerResponse = { created: boolean; customer?: Customer };
export type ReleaseHoldResponse = { tracked?: TrackedUsage };
export type RemoveAddOnRequest = { asOf?: number; expectedRevision?: RevisionInput; reason?: string; target?: ProductTarget };
export type RemoveAddOnResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type ReportUsageRequest = { amount?: number; currency?: string; featureKey?: string; idempotencyKey?: string; mode?: UsageMode; occurredAtMs?: number; register?: boolean; target?: ProductTarget };
export type ReportUsageResponse = { tracked?: TrackedUsage };
export type RevisionInput = { value?: number };
export type RevokeGrantRequest = { expectedRevision?: RevisionInput; reason?: string; target?: ProductTarget };
export type RevokeGrantResponse = { changed: boolean; grant?: Grant; revision: number };
export type Rounding = "ROUNDING_UNSPECIFIED" | "ROUNDING_NEAREST" | "ROUNDING_UP" | "ROUNDING_DOWN";
export type ScheduledChange = { acceptanceRequired: boolean; accepted: boolean; amount?: Amount; effectiveAt: number; planId: string; rolloutId: string; versionNumber: number };
export type Selling = "SELLING_UNSPECIFIED" | "SELLING_SELF_SERVE" | "SELLING_SALES_LED";
export type ServedCatalogue = { changeId?: string; nothing?: NothingServed; release?: ServedRelease; track?: ServedTrack };
export type ServedRelease = { id: string; number: number };
export type ServedTrack = { id: string; name: string };
export type SetAddOnRequest = { asOf?: number; expectedRevision?: RevisionInput; quantity?: number; reason?: string; register?: boolean; replaces?: PlanSelector; target?: ProductTarget };
export type SetAddOnResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type SetPlanRequest = { asOf?: number; country?: string; end?: EndProduct; endBilling?: boolean; expectedRevision?: RevisionInput; keepBilling?: boolean; latestVersion?: boolean; market?: string; offers?: OfferChoice[]; periodId?: string; reason?: string; register?: boolean; set?: PlanSelector; target?: ProductTarget; until?: number; waiveExitCharges?: boolean; when?: SubscriptionMoveWhen };
export type SetPlanResponse = { confirming?: PaymentConfirming; done?: MoveResult; pay?: PaymentStep };
export type SettleHoldRequest = { amount?: number; target?: ProductTarget };
export type SettleHoldResponse = { tracked?: TrackedUsage };
export type SnapshotKeySet = { keys: { alg: "ES256"; crv: "P-256"; kid: string; kty: "EC"; use: "sig"; x: string; y: string }[] };
export type StripeListingIds = { priceId: string };
export type SubscriptionCollection = "SUBSCRIPTION_COLLECTION_UNSPECIFIED" | "SUBSCRIPTION_COLLECTION_PROVIDER" | "SUBSCRIPTION_COLLECTION_BUSINESS" | "SUBSCRIPTION_COLLECTION_NOT_CHARGED";
export type SubscriptionMovePolicy = "SUBSCRIPTION_MOVE_POLICY_UNSPECIFIED" | "SUBSCRIPTION_MOVE_POLICY_UPGRADE" | "SUBSCRIPTION_MOVE_POLICY_DOWNGRADE" | "SUBSCRIPTION_MOVE_POLICY_CROSSGRADE" | "SUBSCRIPTION_MOVE_POLICY_LONGER" | "SUBSCRIPTION_MOVE_POLICY_SHORTER";
export type SubscriptionMoveWhen = "SUBSCRIPTION_MOVE_WHEN_UNSPECIFIED" | "SUBSCRIPTION_MOVE_WHEN_NOW" | "SUBSCRIPTION_MOVE_WHEN_PERIOD_END";
export type SubscriptionPrice = { atRenewal?: CustomerPriceLines; nextCharges: NextCharge[]; now: CustomerPriceLine[]; productId?: string; renewsAt: number; subscriptionId: string };
export type SwitchOn = Record<string, never>;
export type SyncBillingRequest = { target?: ProductTarget };
export type SyncBillingResponse = { changed: boolean };
export type TermThen = "TERM_THEN_UNSPECIFIED" | "TERM_THEN_RENEW" | "TERM_THEN_ROLLING" | "TERM_THEN_END";
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
export type WindowAnchor = "WINDOW_ANCHOR_UNSPECIFIED" | "WINDOW_ANCHOR_PERIOD" | "WINDOW_ANCHOR_CALENDAR";
export type WindowUnit = "WINDOW_UNIT_UNSPECIFIED" | "WINDOW_UNIT_HOURS" | "WINDOW_UNIT_DAYS" | "WINDOW_UNIT_WEEKS" | "WINDOW_UNIT_MONTHS";
export type YearlyDate = { day: number; month: number };
export type YearlyOn = { dates: YearlyDate[] };
export type Zone = { key: string; name: string };

export const ROUTES = {
  "Billing.CreatePortalSession": { method: "POST", path: "/v1/customers/{external_id}/billing/portal-sessions", query: [] },
  "Billing.GetBilling": { method: "GET", path: "/v1/customers/{external_id}/billing", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Billing.SyncBilling": { method: "POST", path: "/v1/customers/{external_id}/billing:sync", query: [] },
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
  "Pricing.ListFeaturesOnSale": { method: "GET", path: "/v1/pricing/features", query: ["target.team_id","target.project_id","target.environment_id"] },
  "SnapshotKeys": { method: "GET", path: "/v1/snapshot-keys", query: [] },
  "Snapshots.CreateSnapshot": { method: "POST", path: "/v1/customers/{external_id}/snapshots", query: [] },
  "Subscriptions.CancelPendingAddOnChange": { method: "POST", path: "/v1/customers/{external_id}/add-ons/{plan_key}:cancelPendingChange", query: [] },
  "Subscriptions.CancelPendingChange": { method: "POST", path: "/v1/customers/{external_id}/subscription:cancelPendingChange", query: [] },
  "Subscriptions.CancelSubscription": { method: "POST", path: "/v1/customers/{external_id}/subscription:cancel", query: [] },
  "Subscriptions.ChooseSubscription": { method: "POST", path: "/v1/customers/{external_id}/subscription", query: [] },
  "Subscriptions.ListAvailablePlans": { method: "GET", path: "/v1/customers/{external_id}/plans", query: ["target.team_id","target.project_id","target.environment_id","as_of"] },
  "Subscriptions.RemoveAddOn": { method: "POST", path: "/v1/customers/{external_id}/add-ons/{plan_key}:remove", query: [] },
  "Subscriptions.SetAddOn": { method: "PUT", path: "/v1/customers/{external_id}/add-ons/{plan_key}", query: [] },
  "Subscriptions.SetPlan": { method: "PUT", path: "/v1/customers/{external_id}/plan", query: [] },
  "Usage.AdjustMeter": { method: "POST", path: "/v1/customers/{external_id}/meters/{feature_key}:adjust", query: [] },
  "Usage.CancelReport": { method: "POST", path: "/v1/customers/{external_id}/usage/{usage_id}:cancel", query: [] },
  "Usage.CreateHold": { method: "POST", path: "/v1/customers/{external_id}/usage/holds", query: [] },
  "Usage.ReleaseHold": { method: "DELETE", path: "/v1/customers/{external_id}/usage/holds/{hold_id}", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Usage.ReportUsage": { method: "POST", path: "/v1/customers/{external_id}/usage", query: [] },
  "Usage.SettleHold": { method: "POST", path: "/v1/customers/{external_id}/usage/holds/{hold_id}:settle", query: [] },
} as const;
