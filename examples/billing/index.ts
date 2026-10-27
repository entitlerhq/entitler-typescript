import type { Customer, EntitlerClient, Lane } from "@entitlerhq/entitler";

export async function upgrade(customer: Customer, plan: string, returnUrl: string, quantity = 1): Promise<string> {
  const step = await customer.subscribe(plan, { returnUrl, quantity });
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

function holds(lane: Lane, plan: string, quantity: number): boolean {
  if (lane.plan?.key === plan) return true;
  return lane.addOns.some((addOn) => addOn.key === plan && addOn.quantity === quantity);
}

export async function afterPayment(entitler: EntitlerClient, plan: string, quantity = 1): Promise<string> {
  const synced = await entitler.me.syncBilling().then(
    () => true,
    () => false,
  );
  const plans = synced ? await entitler.me.plans({ revalidate: true }).catch(() => null) : null;
  const paid = !plans?.stale && (plans?.holdings?.lanes.some((lane) => holds(lane, plan, quantity)) ?? false);
  return paid ? "active" : "pending";
}
