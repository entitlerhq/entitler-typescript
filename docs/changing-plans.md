# Changing plans

`plans()` answers the plans a customer holds (`held`) and the plans they can move to (`options`).
Each option says how the customer would move (`subscribe`, `move`, `add` or `replace`), its
`direction` (up, down or across), its `mode` (self-serve or sales-led), whether the customer may
choose it themselves (`selfServe`), why it is unavailable (`disabledReason`), when it takes effect,
its `impact` on the customer's features and limits, and the `skus` that buy it.

```ts
const plans = await customer.plans();
for (const held of plans.held) console.log(`Holds ${held.plan.name}`);
for (const option of plans.options) {
  if (option.disabledReason) continue;
  console.log(`${option.direction}: ${option.plan.name}, ${option.impact.map((each) => each.text).join("; ")}`);
}
```

On the in-app client, `plans()` needs the organisation's customer portal capability; without it,
Entitler answers `409 limit_reached`.

## Upgrades

A check's `upgrades` names the plans that would give a feature the customer lacks, so an upgrade
prompt can offer the right one:

```ts
const check = await customer.check(features.exportPdf);
if (!check.entitled) console.log(`Upgrade to ${check.upgrades[0]?.name ?? "a paid plan"}.`);
```

Then move the customer with `subscribe`, naming the period by its label as pricing shows it:

```ts
await customer.subscribe("pro", { period: "Monthly" });
```

## Downgrades

A move down is usually booked for the end of the period. It shows in `subscription.pending`, and
`undoPendingChange()` takes it back:

```ts
const change = await customer.subscribe("free");
if (change.subscription?.pending?.type === "move") await customer.undoPendingChange();
```

See [billing](billing.md) for checkout, add-ons and the vendor's own changes.
