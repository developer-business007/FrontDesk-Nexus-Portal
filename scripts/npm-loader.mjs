import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** Map Deno `npm:` specifiers to installed Node packages for local SynXis sync. */
function toNodePackage(specifier) {
  const rest = specifier.slice("npm:".length);
  if (rest.startsWith("@supabase/supabase-js")) return "@supabase/supabase-js";
  // SynXis Gmail MFA modules import imapflow, but DualPMS bridge doesn't use it.
  // Keep this mapping best-effort: if imapflow isn't installed, resolve() will fail.
  if (rest.startsWith("imapflow")) return "imapflow";
  if (rest.startsWith("ssh2")) return "ssh2";
  return rest.replace(/@\d[\d.]*$/, "");
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("npm:")) {
    const pkg = toNodePackage(specifier);
    const resolved = require.resolve(pkg);
    return nextResolve(pathToFileURL(resolved).href, context);
  }
  return nextResolve(specifier, context, nextResolve);
}
