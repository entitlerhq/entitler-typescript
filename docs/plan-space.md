# Plan space and upgrades

`planSpace()` answers the plans a customer holds and every move open to them, each with whether
the customer may choose it themselves (`selfServe`), why it is unavailable (`disabledReason`), when
it takes effect, what it changes (`impact`), and the SKUs that sell it.

```ts
const space = await customer.planSpace();
for (const held of space.held) console.log(`Holds ${held.plan.name}`);
for (const option of space.options) {
  if (option.disabledReason) continue;
  console.log(`${option.move} ${option.plan.name}: ${option.impact.map((each) => each.text).join("; ")}`);
}
```

A check's `upgrades` names the plan moves that would give a feature the customer lacks, so an
upgrade prompt can offer the right plan:

```ts
const check = await customer.check(features.exportPdf);
if (!check.entitled) console.log(`Upgrade to ${check.upgrades[0]?.name ?? "a paid plan"}.`);
```

Then move the customer with the [billing](billing.md) calls.
