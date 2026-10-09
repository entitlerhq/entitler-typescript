import { ApiError, defineFeature, EntitlerServer } from "@entitlerhq/entitler";

const sso = defineFeature("sso", "boolean");
const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? `billing-${Date.now()}`);
await customer.register({ name: "Billing example" });

const change = await customer.subscribe("pro_basic", { period: "Monthly" });
console.log(`Subscribed to ${change.subscription?.plan.name}.`);

const plans = await customer.plans();
console.log(`Holds: ${plans.held.map((held) => held.plan.name).join(", ")}`);
for (const option of plans.options) {
  console.log(`  Could ${option.move} to ${option.plan.name}${option.selfServe ? "" : " (contact sales)"}`);
}

try {
  const page = await customer.checkout("pro", {
    successUrl: "https://example.com/billing/done",
    cancelUrl: "https://example.com/billing",
  });
  console.log(`Send the customer to ${page.url}`);
} catch (error) {
  if (!(error instanceof ApiError && error.code === "stale")) throw error;
  console.log("No payment provider is connected yet, so checkout is not available.");
}

await customer.vendor.grant(sso, { days: 14, reason: "Trial of SSO" });
console.log(`SSO granted: ${(await customer.check(sso)).entitled}.`);

if (!process.env.CUSTOMER_ID) await customer.delete({ erase: true });
