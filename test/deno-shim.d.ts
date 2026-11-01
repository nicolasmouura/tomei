// Só para o `tsc` local conferir os tipos do index.ts fora do Deno.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};
