declare module "express" {
  export interface Request {
    header(name: string): string | undefined;
  }
  export interface Response {
    status(code: number): Response;
    json(body: unknown): Response;
    type(type: string): Response;
    send(body: string): Response;
  }
  export type NextFunction = (error?: unknown) => void;
  type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
  interface Application {
    post(path: string, ...handlers: Handler[]): Application;
    listen(port: number): unknown;
  }
  export default function express(): Application;
}

declare module "next/server" {
  export class NextResponse extends Response {
    static json(body: unknown, init?: ResponseInit): NextResponse;
  }
}

declare module "next/headers" {
  export function cookies(): Promise<{ get(name: string): { value: string } | undefined }>;
}

declare module "react" {
  export function useState<T>(): [T | undefined, (value: T) => void];
  export function useEffect(effect: () => undefined | (() => void), deps: readonly unknown[]): void;
}
