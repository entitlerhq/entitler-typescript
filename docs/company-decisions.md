# Company decisions

`ServerCustomer` adds the changes your company makes for a deal, a support ticket or a verified store
purchase. They follow no self-serve rules, so sales-led plans are open to them. Each takes `actor`,
the person or system that decided (a support agent's id, `hubspot`), and `reason`, which the
customer's activity shows beside your key's name.

## Plans: `setPlan`

```ts
await customer.setPlan("enterprise", {
  period: "yearly",
  billing: "end",
  actor: "hubspot",
  reason: "Enterprise contract signed",
  idempotencyKey: "hubspot-deal-8812-won",
});
```

- `billing: "provider"` (the default) charges the change through the provider that bills the product.
- `billing: "keep"` moves the customer in Entitler while the provider keeps billing the plan it bills,
  as a deliberate exception such as a goodwill upgrade, until a later `setPlan`.
- `billing: "end"` ends the provider's subscription when the change takes effect (now, prorated; or
  at renewal), and the customer then holds the plan outside any provider, as with an invoiced
  contract. Moving a Stripe payer onto invoiced Enterprise is this one write.
- `when` is `now` or `end` (at renewal); left out, the project's policy decides.
- `until` returns the customer to the product's default plan at that instant, unless a later
  `setPlan` moved them or set a later `until`.

The plan the customer already holds, with the same period, billing and `until`, changes nothing and
answers `changed: false`, so a redelivered webhook is harmless even with a new key.

## Add-ons: `setAddOn`

`setAddOn` adds an add-on, sets its quantity, or removes it at `0`, in one write:

```ts
await customer.setAddOn("extra_seats", { quantity: 150, actor: "salesforce" });
await customer.setAddOn("extra_seats", { quantity: 0, reason: "Seats moved into the plan" });
```

## Grants

`grant` gives a feature for a while (`days`, 0 for no end), or an amount of one. It answers the
grant made, so a support tool keeps its id for `revokeGrant`:

```ts
const { grant } = await customer.grant(features.sso, { days: 30, reason: "Pilot", actor: "agent_17" });
await customer.revokeGrant(grant.id, { actor: "agent_17" });
```

## Meters

`adjustMeter` moves a meter `by` an amount, or sets it `to` one; it never goes below 0. `by` gives
credits back without racing new usage, as a read-then-set would. Its idempotency key is required,
so a support tool's double submit applies once. `cancelUsage` takes back one usage report:

```ts
await customer.adjustMeter(features.aiCredits, { by: -500, idempotencyKey: "ticket-4411-refund" });
await customer.adjustMeter(features.aiCredits, { to: 0, idempotencyKey: "ticket-4412-reset" });
await customer.cancelUsage("use_123", { reason: "Duplicate import" });
```

## Keys from the event

Every write takes `idempotencyKey`. Take it from the event that caused the write (this webhook
delivery, this deal stage change), never from an object whose state changes, such as the deal: a
key is never freed, so a deal won a second time after churning needs a new key, or its write replays
the first one and moves nobody. The answer's `replayed` says when a write sent again changed nothing.
