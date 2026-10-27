import { describe, expect, it } from "vitest";
import { route } from "../../src/routes.js";

describe("route", () => {
  it("fills the path and keeps the query", () => {
    expect(route("Entitlements.CheckFeature", { external_id: "a/b", feature_key: "f" }, { as_of: "1" })).toEqual({
      method: "GET",
      path: "/v1/customers/a%2Fb/entitlements/f",
      query: { as_of: "1" },
    });
  });

  it("refuses a missing path variable and an unknown query parameter", () => {
    expect(() => route("Entitlements.CheckFeature", { feature_key: "f" })).toThrow(
      "Entitlements.CheckFeature needs external_id.",
    );
    expect(() => route("Entitlements.ListEntitlements", { external_id: "a" }, { page: "2" })).toThrow(
      "Entitlements.ListEntitlements takes no page.",
    );
  });

  it("refuses an id made only of dots", () => {
    expect(() => route("Entitlements.ListEntitlements", { external_id: ".." })).toThrow(
      "Pass an id that is not made only of dots.",
    );
  });
});
