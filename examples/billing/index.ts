import type { Customer, EntitlerClient } from "@entitlerhq/entitler";

export async function upgrade(customer: Customer, plan: string, returnUrl: string): Promise<string> {
  const step = await customer.subscribe(plan, { returnUrl });
  switch (step.next) {
    case "pay":
      location.assign(step.url);
      return "paying";
    case "confirming":
      return "confirming";
    case "done":
      return step.result.change?.effective === "renewal" ? "booked for renewal" : "upgraded";
  }
}

export async function afterPayment(entitler: EntitlerClient): Promise<void> {
  await entitler.me.syncBilling();
  const { options, holdings } = await entitler.me.plans();
  console.log(
    holdings?.lanes.map((lane) => lane.plan?.name),
    options.map((option) => option.plan.key),
  );
}
