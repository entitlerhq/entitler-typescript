import { EntitlerVisitor, type PricedPlan } from "@entitlerhq/entitler";

const entitler = new EntitlerVisitor({ key: "pk_live_your_publishable_key" });

function priceOf(plan: PricedPlan): string {
  if (plan.priceState === "free") return "Free";
  const priced = plan.prices.filter((line) => line.price !== null);
  const monthly = plan.periods.find((period) => period.unit === "months" && period.count === 1);
  const line = priced.find((price) => price.period === monthly?.id) ?? priced[0];
  if (!line?.price) return "Contact us";
  const period = plan.periods.find((candidate) => candidate.id === line.period);
  const from = line.bands.length > 0 ? "From " : "";
  return `${from}${line.price.display}${period ? ` / ${period.label}` : ""}`;
}

const sheet = await entitler.pricing({ country: "AU", locale: navigator.language });
for (const plan of sheet.plans) console.log(plan.name, priceOf(plan));
