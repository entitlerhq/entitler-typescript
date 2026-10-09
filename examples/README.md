# Examples

Each example is a small program. Build the SDK once with `bun install && bun run build`, then run an
example from the repository root with your test environment's key in `ENTITLER_KEY`:

| Example | What it shows | Run it |
| --- | --- | --- |
| [quickstart](quickstart/index.ts) | Register a customer, check a feature with `isEntitled`, record usage | `ENTITLER_KEY=ent_test_… bun examples/quickstart/index.ts` |
| [pricing-page](pricing-page/index.ts) | Print the pricing as a pricing page would, for a visitor id from `newVisitorId()` | `ENTITLER_KEY=ent_test_… bun examples/pricing-page/index.ts` |
| [in-app](in-app/index.ts) | Mint a customer token on the server, then check and record usage for `me` with a token provider | `ENTITLER_KEY=ent_test_… bun examples/in-app/index.ts` |
| [metered-work](metered-work/index.ts) | `withHold` around work whose cost is known only afterwards, and an observe-mode report | `ENTITLER_KEY=ent_test_… bun examples/metered-work/index.ts` |
| [offline](offline/index.ts) | Fetch a snapshot and the keys, then verify the snapshot offline and check a feature | `ENTITLER_KEY=ent_test_… bun examples/offline/index.ts` |
| [billing](billing/index.ts) | Subscribe self-serve, show the plans they can move to, start a checkout and handle `409 stale`, and a vendor grant | `ENTITLER_KEY=ent_test_… bun examples/billing/index.ts` |
| [generated-features](generated-features/index.ts) | A generated constants file and code that uses it | `ENTITLER_KEY=ent_test_… bun examples/generated-features/index.ts` |
| [cloudflare-worker](cloudflare-worker/index.ts) | A Cloudflare Worker gating a route, with one client at module scope | `ENTITLER_KEY=ent_test_… bun examples/cloudflare-worker/main.ts` |

Node.js 22.18 or later runs them too: `node examples/quickstart/index.ts`. Set `CUSTOMER_ID` to act on a
customer of your own.
