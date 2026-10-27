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
  const synced = await entitler.me.syncBilling().then(
    () => true,
    () => false,
  );
  const plans = synced ? await entitler.me.plans({ revalidate: true }).catch(() => null) : null;
  const paid =
    !plans?.stale &&
    (plans?.holdings?.lanes.some(
      (lane) => lane.plan?.key === plan || lane.addOns.some((addOn) => addOn.key === plan),
    ) ??
      false);
  return paid ? "active" : "pending";
}
