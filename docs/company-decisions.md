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
  contract. Moving a Stripe payer onto invoiced Enterprise is this one write. Booked for renewal, it
  shows in `plans()` as a `pending` of type `billing` until then.
- `when` is `now` or `end` (at renewal); left out, the project's policy decides.
- `until` returns the customer to the product's default plan at that instant, unless a later
  `setPlan` moved them or set a later `until`.

- `version: "latest"` moves the customer now to the newest version of the plan they hold, ending a
  grandfathered version; `changed` is false when they are already on it.
- `until` comes after any change booked for renewal, and while Stripe bills the product it needs
  `billing: "end"` (`400 invalid_body` otherwise).

To end the customer's plan in a product, pass `null` and the product. They move to its default plan,
or hold no plan when it has none, now or at renewal; `billing: "keep"` is refused, and `period`,
`until` and `version` never go with it:

```ts
await customer.setPlan(null, { product: "app", when: "end", actor: "hubspot", idempotencyKey: "deal-8841-lost" });
```

The plan the customer already holds, with the same period, billing and `until`, changes nothing and
answers `changed: false`, so a redelivered webhook is harmless even with a new key. Two exceptions
change something: naming the plan held undoes a change booked for renewal, and naming it with
`billing` `provider` or `end` ends a `keep` exception.

## Add-ons: `setAddOn`

`setAddOn` adds an add-on, sets its quantity, or removes it at `0`, in one write that always takes
effect now (an add-on change cannot be booked for renewal):

```ts
await customer.setAddOn("extra_seats", { quantity: 150, actor: "salesforce" });
await customer.setAddOn("extra_seats", { quantity: 0, reason: "Seats moved into the plan" });
await customer.setAddOn("support_premium", { quantity: 1, replaces: "support_standard" });
```

`replaces` swaps one add-on for another in one write, as `plans()` lists a `replace` move. Naming an
add-on's held quantity undoes an add-on move booked for renewal.

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
