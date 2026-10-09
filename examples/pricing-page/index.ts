import { EntitlerClient, EntitlerServer, type Pricing, type PricingPlan } from "@entitlerhq/entitler";

function priceOf(plan: PricingPlan, period: string): string {
  const listing = plan.listings.find((each) => each.period.key === period);
  const price = listing?.channels.find((channel) => channel.purchasable && channel.price)?.price;
  if (!price) return "Coming soon";
  return `${(price.amount / 100).toFixed(2)} ${price.currency.toUpperCase()}`;
}

function print(title: string, pricing: Pricing): void {
  console.log(`${title}${pricing.experiment ? ` (arm ${pricing.experiment.arm})` : ""}`);
  for (const plan of pricing.plans.filter((each) => each.kind === "plan")) {
    console.log(`\n${plan.name}${plan.default ? " (free to start)" : ""}`);
    if (plan.description) console.log(`  ${plan.description}`);
    for (const period of plan.periods) console.log(`  ${period.label}: ${priceOf(plan, period.key)}`);
    if (plan.salesLed) console.log("  Contact sales");
  }
}

const publishable = process.env.ENTITLER_PUBLISHABLE_KEY;
if (publishable) {
  const signedOut = new EntitlerClient({ key: publishable });
  print("Pricing in the app, signed out", await signedOut.pricing());
  signedOut.close();
}

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });
const visitor = server.newVisitorId();
print(`\nPricing from the server for visitor ${visitor}`, await server.pricing({ visitor }));
server.close();
