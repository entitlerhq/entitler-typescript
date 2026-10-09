import { ApiError, type Customer, EntitlerServer, type SubscribeStep } from "@entitlerhq/entitler";

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const customer = server.customer(process.env.CUSTOMER_ID ?? `billing-${Date.now()}`);
await customer.register({ name: "Billing example" });

async function billingPage(viewer: Customer): Promise<void> {
  const plans = await viewer.plans();
  for (const held of plans.held) {
    const manage =
      held.billedBy === "apple" || held.billedBy === "google" ? `the ${held.billedBy} store` : "the billing portal";
    console.log(`Holds ${held.plan.name} (${held.period?.label ?? "no period"}), managed in ${manage}.`);
  }
  for (const option of plans.options) {
    const buttons: Record<string, string> = { buy: "Buy", contact: "Contact sales", unavailable: "Unavailable" };
    const button = buttons[option.action] ?? option.action;
    console.log(`  ${button}: ${option.move} to ${option.plan.name}`);
  }
}

function show(step: SubscribeStep): void {
  if (step.next === "done") console.log(`Done: on ${step.plan?.name ?? "no plan"} from ${step.at.toISOString()}.`);
  else if (step.next === "pay") console.log(`Send the customer to ${step.url}`);
  else if (step.next === "confirming") console.log("The bank is confirming the payment.");
  else if (step.next === "manage") console.log(`The customer changes this through ${step.billedBy}.`);
  else console.log(`A step this SDK does not know: ${step.raw}`);
}

await billingPage(customer);
show(await customer.subscribe("pro", { period: "monthly", returnUrl: "https://example.com/billing/return" }));

await customer.syncBilling();
await customer.plans({ revalidate: true });

const cancel = await customer.cancel();
console.log(`Cancel ${cancel.changed ? `takes effect ${cancel.effective}` : "changed nothing"}.`);
await customer.undoPendingChange();

try {
  const portal = await customer.billingPortal({ returnUrl: "https://example.com/account" });
  console.log(`Send the customer to ${portal.url}`);
} catch (error) {
  if (!(error instanceof ApiError && error.code === "stale")) throw error;
  console.log("No provider has billed this customer yet, so there is no billing portal.");
}

const contract = await customer.setPlan("pro", {
  period: "yearly",
  billing: "end",
  actor: "billing-example",
  reason: "Invoiced contract",
  idempotencyKey: `${customer.id}-contract`,
});
console.log(`Company change: ${contract.changed ? "made" : "nothing to change"}.`);

const { grant } = await customer.grant("sso", { days: 14, reason: "Trial of SSO", actor: "billing-example" });
console.log(`Granted SSO as ${grant.id}.`);

if (!process.env.CUSTOMER_ID) await customer.erase();
server.close();
