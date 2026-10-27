import { EntitlerVisitor } from "@entitlerhq/entitler";

const entitler = new EntitlerVisitor({ key: "pk_live_your_publishable_key" });

const sheet = await entitler.pricing({ country: "AU", locale: navigator.language });
for (const plan of sheet.plans) {
  const monthly = plan.prices.find((price) => price.period === plan.periods[0]?.id);
  console.log(plan.name, monthly?.price?.display ?? "Contact us");
}
