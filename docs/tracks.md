# Tracks

A track decides which release or change of the catalogue a customer is served. Everyone starts on All
customers; testers' tracks follow an open change. Every check, entitlement list, customer's plans, usage
answer and pricing names the track it came from, with its `release` or `change`.

Move a customer with `setTrack`, and back to All customers with `null`:

```ts
const beta = await customer.setTrack("j034…");
console.log(beta.track.name, beta.previousTrackId);
await customer.setTrack(null);
```

`setTrack` needs `tracks:assign`. Creating tracks and rolling out releases belong to the dashboard.
