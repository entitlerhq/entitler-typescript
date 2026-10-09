# Tracks

A track decides which release or change of the catalogue a customer is served. Everyone starts on All
customers; testers' tracks follow an open change. Every check, entitlement list, customer's plans,
usage answer and pricing names the track it came from, with its `release` or `change`.

Move a customer with `setTrack`, naming the track by its name, which stays the same in every
environment, and back to All customers with `null`:

```ts
const beta = await customer.setTrack("Beta");
console.log(beta.track.name, beta.previousTrackId);
await customer.setTrack(null);
```

`setTrack` needs `tracks:assign`, which the dashboard's server key preset lacks: a key minted from
that preset answers `403 scope_required` until the scope is added. An unknown name answers
`404 not_found`. Creating tracks and rolling out releases belong to the dashboard.
