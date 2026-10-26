import { segment } from "./util.js";
import { ROUTES } from "./wire.gen.js";

/** An operation the SDK calls, by its `Service.Method` name. @internal */
export type Operation = keyof typeof ROUTES;

/** An operation's method, path and query, with its path variables filled in. @internal */
export function route(
  operation: Operation,
  variables: Record<string, string>,
  query: Record<string, string | undefined> = {},
): { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; query: Record<string, string | undefined> } {
  const { method, path, query: names } = ROUTES[operation];
  const filled = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`${operation} needs ${name}.`);
    return segment(value);
  });
  for (const name of Object.keys(query)) {
    if (!(names as readonly string[]).includes(name)) throw new Error(`${operation} takes no ${name}.`);
  }
  return { method, path: filled, query };
}
