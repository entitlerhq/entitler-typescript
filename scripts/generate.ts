interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  required?: string[];
}

interface Parameter {
  in: "path" | "query";
  name: string;
}

interface Operation {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: { "200": { content: { "application/json": { schema: Schema } } } };
}

/** The API document's shape, as far as the generator reads it. */
export interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

/** The operations the SDK calls. Only these and the types they reach are generated. */
export const OPERATIONS = [
  "Entitlements.CheckFeature",
  "Entitlements.ListEntitlements",
  "Usage.ReportUsage",
  "Usage.CreateHold",
  "Usage.SettleHold",
  "Usage.ReleaseHold",
  "Customers.RegisterCustomer",
  "Customers.GetCustomer",
  "Customers.UpdateCustomer",
  "Customers.EraseCustomer",
  "CustomerTokens.CreateToken",
];

const REF = "#/components/schemas/";

const typeName = (ref: string) => ref.slice(ref.lastIndexOf(".") + 1).replaceAll("-", "");

const property = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));

function render(schema: Schema, refs: Set<string>): string {
  if (schema.$ref) {
    const name = schema.$ref.slice(REF.length);
    refs.add(name);
    return typeName(name);
  }
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.map((type) => renderType(type, schema, refs)).join(" | ");
}

function renderType(type: string | undefined, schema: Schema, refs: Set<string>): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${render(schema.items ?? {}, refs)}[]`;
    case "object": {
      const required = new Set(schema.required);
      const fields = Object.entries(schema.properties ?? {}).map(
        ([name, field]) => `${property(name)}${required.has(name) ? "" : "?"}: ${render(field, refs)}`,
      );
      if (typeof schema.additionalProperties === "object") {
        fields.push(`[key: string]: ${render(schema.additionalProperties, refs)}`);
      }
      return fields.length === 0 ? "Record<string, never>" : `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

/** The wire types and routes of the operations the SDK calls, as a TypeScript module. */
export function generate(document: Document, operations: readonly string[] = OPERATIONS): string {
  const found = new Map<string, { method: string; path: string; operation: Operation }>();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      found.set(operation.operationId, { method: method.toUpperCase(), path, operation });
    }
  }
  const refs = new Set<string>();
  const routes = [...operations].sort().map((id) => {
    const route = found.get(id);
    if (!route) throw new Error(`The API document has no operation ${id}.`);
    const body = route.operation.requestBody?.content["application/json"].schema;
    if (body) render(body, refs);
    render(route.operation.responses["200"].content["application/json"].schema, refs);
    const query = (route.operation.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
    return `  ${JSON.stringify(id)}: { method: ${JSON.stringify(route.method)}, path: ${JSON.stringify(route.path)}, query: ${JSON.stringify(query)} },`;
  });

  const types = new Map<string, string>();
  for (let pending = [...refs]; pending.length > 0; pending = [...refs].filter((ref) => !types.has(ref))) {
    for (const ref of pending) {
      const schema = document.components.schemas[ref];
      if (!schema) throw new Error(`The API document has no schema ${ref}.`);
      types.set(ref, `export type ${typeName(ref)} = ${render(schema, refs)};`);
    }
  }

  return [
    "/** The API's wire types and routes, generated from openapi.json by scripts/generate.ts. @internal */",
    "",
    ...[...types].sort(([a], [b]) => typeName(a).localeCompare(typeName(b))).map(([, type]) => type),
    "",
    "export const ROUTES = {",
    ...routes,
    "} as const;",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const document = (await Bun.file("openapi.json").json()) as Document;
  await Bun.write("src/wire.gen.ts", generate(document));
}
