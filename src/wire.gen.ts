/** The API's wire types and routes, generated from openapi.json by scripts/generate.ts. @internal */

export type AddOnSource = { planId: string; planKey: string; planName: string; quantity: number; throughFeatureKey?: string; value?: FeatureValue; versionNumber: number };
export type CheckFeatureResponse = { asOf: number; customer?: EntitledCustomer; entitlement?: Entitlement; nextChangeAt?: number; served?: ServedCatalogue };
export type CreateHoldRequest = { amount?: number; currency?: string; customer?: CustomerRef; featureKey?: string; idempotencyKey?: string; target?: ProductTarget; ttlSeconds?: number };
export type CreateHoldResponse = { tracked?: TrackedUsage };
export type CreateTokenRequest = { externalId?: string; lifetimeSeconds?: number; scopes?: CustomerTokenScope[]; target?: ProductTarget };
export type CreateTokenResponse = { customerId?: string; expiresAt: number; scopes: CustomerTokenScope[]; token: string; tokenId: string };
export type CredentialCustomer = Record<string, never>;
export type Customer = { attributes: CustomerAttribute[]; createdAt: number; email?: string; environmentId: string; externalId: string; id: string; identityProviderId?: string; marketId?: string; money: CustomerMoney; name?: string; projectId: string; revision: number; trackId?: string; updatedAt: number };
export type CustomerAttribute = { key: string; value: string };
export type CustomerAttributeChange = { key?: string; value?: string };
export type CustomerMoney = "CUSTOMER_MONEY_UNSPECIFIED" | "CUSTOMER_MONEY_REAL" | "CUSTOMER_MONEY_TEST";
export type CustomerRef = { externalId?: string; me?: CredentialCustomer };
export type CustomerTokenScope = "CUSTOMER_TOKEN_SCOPE_UNSPECIFIED" | "CUSTOMER_TOKEN_SCOPE_ENTITLEMENTS_READ" | "CUSTOMER_TOKEN_SCOPE_USAGE_READ" | "CUSTOMER_TOKEN_SCOPE_USAGE_WRITE" | "CUSTOMER_TOKEN_SCOPE_BILLING_SELF";
export type DefaultPlanSource = { planId: string; planKey: string; planName: string; productId?: string; throughFeatureKey?: string; versionNumber: number };
export type EntitledCustomer = { customerId?: string; externalId: string };
export type EntitledFeatureKind = "ENTITLED_FEATURE_KIND_UNSPECIFIED" | "ENTITLED_FEATURE_KIND_SWITCH" | "ENTITLED_FEATURE_KIND_METERED" | "ENTITLED_FEATURE_KIND_CONFIGURATION" | "ENTITLED_FEATURE_KIND_GROUP";
export type Entitlement = { currency: string; decimals: number; entitled: boolean; featureKey: string; kind: EntitledFeatureKind; meter?: Meter; sources: EntitlementSource[]; upgrades: Upgrade[]; value?: FeatureValue };
export type EntitlementSource = { addOn?: AddOnSource; defaultPlan?: DefaultPlanSource; grant?: GrantSource; group?: GroupSource; plan?: PlanSource };
export type EraseCustomerRequest = { externalId?: string; target?: ProductTarget };
export type EraseCustomerResponse = { erased: number };
export type FeatureValue = { configuration?: Limit; group?: GroupValue; metered?: Limit; switch?: boolean };
export type GetCustomerResponse = { customer?: Customer };
export type GrantSource = { grantId: string; throughFeatureKey?: string; until?: number; value?: FeatureValue };
export type GroupMember = { configuration?: Limit; featureKey: string; group?: GroupValue; metered?: Limit; switch?: boolean };
export type GroupSource = { featureKeys: string[] };
export type GroupValue = { members: GroupMember[] };
export type Limit = { count?: number; unlimited?: Unlimited };
export type ListEntitlementsResponse = { asOf: number; customer?: EntitledCustomer; entitlements: Entitlement[]; nextChangeAt?: number; served?: ServedCatalogue };
export type Meter = { banked: number; held: number; remaining?: Limit; resetsAt?: number; used: number };
export type NothingServed = Record<string, never>;
export type PlanSource = { planId: string; planKey: string; planName: string; productId?: string; throughFeatureKey?: string; value?: FeatureValue; versionNumber: number };
export type ProductTarget = { environmentId?: string; projectId?: string; teamId?: string };
export type RegisterCustomerRequest = { attributes?: CustomerAttributeChange[]; customer?: CustomerRef; email?: string; name?: string; target?: ProductTarget; visitorId?: string };
export type RegisterCustomerResponse = { created: boolean; customer?: Customer };
export type ReleaseHoldResponse = { tracked?: TrackedUsage };
export type ReportUsageRequest = { amount?: number; currency?: string; customer?: CustomerRef; featureKey?: string; idempotencyKey?: string; mode?: UsageMode; occurredAtMs?: number; register?: boolean; target?: ProductTarget };
export type ReportUsageResponse = { tracked?: TrackedUsage };
export type RevisionInput = { value?: number };
export type ServedCatalogue = { changeId?: string; nothing?: NothingServed; release?: ServedRelease; track?: ServedTrack };
export type ServedRelease = { id: string; number: number };
export type ServedTrack = { id: string; name: string };
export type SettleHoldRequest = { amount?: number; customer?: CustomerRef; holdId?: string; target?: ProductTarget };
export type SettleHoldResponse = { tracked?: TrackedUsage };
export type TrackedUsage = { asOf: number; customer?: EntitledCustomer; entitlement?: Entitlement; served?: ServedCatalogue; usage?: UsageResult };
export type Unlimited = Record<string, never>;
export type UpdateCustomerRequest = { attributes?: CustomerAttributeChange[]; email?: string; expectedRevision?: RevisionInput; externalId?: string; name?: string; target?: ProductTarget };
export type UpdateCustomerResponse = { customer?: Customer };
export type Upgrade = { action: UpgradeAction; kind: UpgradeKind; move: UpgradeMove; planId: string; planKey: string; planName: string; productId?: string };
export type UpgradeAction = "UPGRADE_ACTION_UNSPECIFIED" | "UPGRADE_ACTION_BUY" | "UPGRADE_ACTION_CONTACT";
export type UpgradeKind = "UPGRADE_KIND_UNSPECIFIED" | "UPGRADE_KIND_PLAN" | "UPGRADE_KIND_ADD_ON";
export type UpgradeMove = "UPGRADE_MOVE_UNSPECIFIED" | "UPGRADE_MOVE_SUBSCRIBE" | "UPGRADE_MOVE_UPGRADE" | "UPGRADE_MOVE_SWITCH" | "UPGRADE_MOVE_ADD" | "UPGRADE_MOVE_REPLACE";
export type UsageMode = "USAGE_MODE_UNSPECIFIED" | "USAGE_MODE_GATE" | "USAGE_MODE_OBSERVE";
export type UsageOutcome = "USAGE_OUTCOME_UNSPECIFIED" | "USAGE_OUTCOME_RECORDED" | "USAGE_OUTCOME_REFUSED" | "USAGE_OUTCOME_DUPLICATE" | "USAGE_OUTCOME_CANCELLED" | "USAGE_OUTCOME_HELD" | "USAGE_OUTCOME_SETTLED" | "USAGE_OUTCOME_RELEASED" | "USAGE_OUTCOME_ADJUSTED";
export type UsageRefusal = "USAGE_REFUSAL_UNSPECIFIED" | "USAGE_REFUSAL_NOT_ENTITLED" | "USAGE_REFUSAL_OVER_ALLOWANCE";
export type UsageResult = { amount: number; expiresAtMs?: number; holdId?: string; late: boolean; meterChange: number; mode: UsageMode; occurredAtMs?: number; outcome: UsageOutcome; overBy: number; refusal?: UsageRefusal; replayed: boolean; saturated: boolean; usageId?: string };

export const ROUTES = {
  "CustomerTokens.CreateToken": { method: "POST", path: "/v1/customers/{external_id}/tokens", query: [] },
  "Customers.EraseCustomer": { method: "POST", path: "/v1/customers/{external_id}:erase", query: [] },
  "Customers.GetCustomer": { method: "GET", path: "/v1/customers/{external_id}", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Customers.RegisterCustomer": { method: "PUT", path: "/v1/customers/{customer.external_id}", query: [] },
  "Customers.UpdateCustomer": { method: "PATCH", path: "/v1/customers/{external_id}", query: [] },
  "Entitlements.CheckFeature": { method: "GET", path: "/v1/customers/{customer.external_id}/entitlements/{feature_key}", query: ["target.team_id","target.project_id","target.environment_id","as_of"] },
  "Entitlements.ListEntitlements": { method: "GET", path: "/v1/customers/{customer.external_id}/entitlements", query: ["target.team_id","target.project_id","target.environment_id","as_of"] },
  "Usage.CreateHold": { method: "POST", path: "/v1/customers/{customer.external_id}/usage/holds", query: [] },
  "Usage.ReleaseHold": { method: "DELETE", path: "/v1/customers/{customer.external_id}/usage/holds/{hold_id}", query: ["target.team_id","target.project_id","target.environment_id"] },
  "Usage.ReportUsage": { method: "POST", path: "/v1/customers/{customer.external_id}/usage", query: [] },
  "Usage.SettleHold": { method: "POST", path: "/v1/customers/{customer.external_id}/usage/holds/{hold_id}:settle", query: [] },
} as const;
