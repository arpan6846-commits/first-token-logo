// Type shims so `tsc` can check Deno code (worker + Base44 functions) in this repo.
declare namespace Deno {
  const env: { get(k: string): string | undefined };
  function serve(h: (req: Request) => Response | Promise<Response>): unknown;
  function exit(code?: number): never;
  function addSignalListener(sig: string, h: () => void): void;
}
declare module 'npm:@base44/sdk@0.8.62' { export function createClientFromRequest(req: Request): any; }
declare module 'npm:@anthropic-ai/sdk@1.9.0' {
  export default class Anthropic { constructor(o: { apiKey: string }); beta: { messages: { create(p: unknown): Promise<unknown> } }; static APIError: new (...a: any[]) => Error & { status: number }; }
}
