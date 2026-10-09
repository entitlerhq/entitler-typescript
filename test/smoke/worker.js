import { scenario } from "./scenario.js";

export default {
  async fetch() {
    try {
      return Response.json(await scenario());
    } catch (error) {
      return Response.json({ error: String(error?.stack ?? error) });
    }
  },
};
