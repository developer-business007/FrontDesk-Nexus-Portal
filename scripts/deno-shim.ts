/** Lets edge-function shared modules run under Node (they expect Deno.env / Deno.args). */
const argv = process.argv.slice(2);

(globalThis as Record<string, unknown>).Deno = {
  env: {
    get: (key: string) => process.env[key],
  },
  args: argv,
};

export {};
