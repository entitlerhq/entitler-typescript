import worker, { sessionCookie } from "./index.ts";

const env = { ENTITLER_KEY: process.env.ENTITLER_KEY ?? "", SESSION_SECRET: crypto.randomUUID() };
const cookie = await sessionCookie(process.env.CUSTOMER_ID ?? "test_1001", env.SESSION_SECRET);

for (const headers of [{}, { cookie }] as Record<string, string>[]) {
  const response = await worker.fetch(new Request("https://worker.example/export", { headers }), env);
  console.log(`${"cookie" in headers ? "Signed in" : "Signed out"}: ${response.status} ${await response.text()}`);
}
