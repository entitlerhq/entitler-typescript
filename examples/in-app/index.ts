import { EntitlerClient } from "@entitlerhq/entitler";

const entitler = new EntitlerClient({
  token: async ({ signal }) => {
    const response = await fetch("/api/entitler-token", { method: "POST", signal });
    const { token } = (await response.json()) as { token: string };
    return token;
  },
});

const signedIn = new AbortController();
addEventListener("sign-out", () => {
  signedIn.abort();
  entitler.close();
});

try {
  const entitlements = await entitler.me.entitlements({ signal: signedIn.signal });
  document.querySelector("#export")?.toggleAttribute("hidden", !entitlements.has("export_pdf"));
} catch (error) {
  if (!signedIn.signal.aborted) throw error;
}
