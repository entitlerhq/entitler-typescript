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

export async function afterPayment(entitler: EntitlerClient, plan: string): Promise<string> {
  await entitler.me.syncBilling().catch(() => undefined);
  const { holdings } = await entitler.me.plans({ revalidate: true });
  const paid = holdings?.lanes.some((lane) => lane.plan?.key === plan) ?? false;
  return paid ? "active" : "pending";
}
