import worker, { sessionCookie } from "./index.ts";

const port = Number(process.env.PORT ?? 8787);
const env = { ENTITLER_KEY: process.env.ENTITLER_KEY ?? "", SESSION_SECRET: crypto.randomUUID() };
const cookie = await sessionCookie(process.env.CUSTOMER_ID ?? "test_1001", env.SESSION_SECRET);

const { createServer } = await import("node:http");
createServer(async (req, res) => {
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`Listening on http://localhost:${port}; send the header cookie: ${cookie}`));
