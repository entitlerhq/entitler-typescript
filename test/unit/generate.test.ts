import { describe, expect, it } from "vitest";
import { type Document, generate } from "../../scripts/generate.js";

const document: Document = {
  paths: {
    "/v1/things/{thing.id}": {
      get: {
        operationId: "Things.GetThing",
        parameters: [
          { in: "path", name: "thing.id" },
          { in: "query", name: "as_of" },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: { $ref: "#/components/schemas/x.v1.GetThingResponse" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      "x.v1.GetThingResponse": {
        type: "object",
        properties: {
          kind: { $ref: "#/components/schemas/x.v1.Kind" },
          tags: { type: "array", items: { type: "string" } },
          labels: { type: "object", additionalProperties: { type: "string" } },
          empty: { $ref: "#/components/schemas/x.v1.Empty" },
          "odd-name": { type: ["string", "null"] },
        },
        required: ["kind"],
      },
      "x.v1.Kind": { type: "string", enum: ["KIND_A", "KIND_B"] },
      "x.v1.Empty": { type: "object" },
      "x.v1.Unused": { type: "object", properties: { secret: { type: "string" } } },
    },
  },
};

describe("generate", () => {
  it("writes only the routes asked for and the types they reach", () => {
    expect(generate(document, ["Things.GetThing"])).toBe(
      [
        "/** The API's wire types and routes, generated from openapi.json by scripts/generate.ts. @internal */",
        "",
        "export type Empty = Record<string, never>;",
        'export type GetThingResponse = { kind: Kind; tags?: string[]; labels?: { [key: string]: string }; empty?: Empty; "odd-name"?: string | null };',
        'export type Kind = "KIND_A" | "KIND_B";',
        "",
        "export const ROUTES = {",
        '  "Things.GetThing": { method: "GET", path: "/v1/things/{thing.id}", query: ["as_of"] },',
        "} as const;",
        "",
      ].join("\n"),
    );
  });

  it("refuses an operation the document lacks", () => {
    expect(() => generate(document, ["Things.Missing"])).toThrow("The API document has no operation Things.Missing.");
  });
});
