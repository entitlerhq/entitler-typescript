import { EntitlerClient } from "@entitlerhq/entitler";

const entitler = new EntitlerClient({
  token: async () => {
    const response = await fetch("/api/entitler-token", { method: "POST" });
    const { token } = (await response.json()) as { token: string };
    return token;
  },
});

const entitlements = await entitler.me.entitlements();
document.querySelector("#export")?.toggleAttribute("hidden", !entitlements.has("export_pdf"));

addEventListener("sign-out", () => entitler.close());
