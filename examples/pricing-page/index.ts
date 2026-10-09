import { EntitlerServer, type PricingPlan } from "@entitlerhq/entitler";

const server = new EntitlerServer({ key: process.env.ENTITLER_KEY ?? "" });

const visitor = server.newVisitorId();
const pricing = await server.pricing({ visitor });

function priceOf(plan: PricingPlan, period: string): string {
  const listing = plan.listings.find((each) => each.period === period);
  const price = listing?.channels.find((channel) => channel.purchasable && channel.price)?.price;
  if (!price) return "Coming soon";
  return `${(price.amount / 100).toFixed(2)} ${price.currency.toUpperCase()}`;
}

console.log(`Pricing for visitor ${visitor}${pricing.experiment ? ` (arm ${pricing.experiment.arm})` : ""}`);
for (const plan of pricing.plans.filter((each) => each.kind === "plan")) {
  console.log(`\n${plan.name}${plan.default ? " (free to start)" : ""}`);
  if (plan.description) console.log(`  ${plan.description}`);
  for (const period of plan.periods) console.log(`  ${period.label}: ${priceOf(plan, period.label)}`);
  if (plan.salesLed) console.log("  Contact sales");
}
