import { EntitlerVisitor, type PricedPlan } from "@entitlerhq/entitler";

const entitler = new EntitlerVisitor({ key: "pk_live_your_publishable_key" });

function priceOf(plan: PricedPlan): string {
  if (plan.priceState === "free") return "Free";
  const monthly = plan.periods.find((period) => period.unit === "months" && period.count === 1) ?? plan.periods[0];
  const price = plan.prices.find((line) => line.period === (monthly?.id ?? null))?.price;
  if (!price) return "Contact us";
  return monthly ? `${price.display} / ${monthly.label}` : price.display;
}

const sheet = await entitler.pricing({ country: "AU", locale: navigator.language });
for (const plan of sheet.plans) console.log(plan.name, priceOf(plan));
