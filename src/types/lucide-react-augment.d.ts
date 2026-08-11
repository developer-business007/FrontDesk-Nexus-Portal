/**
 * Some icons in `lucide-react@0.468.0` are present at runtime and inside the
 * package's `dist/lucide-react.d.ts`, but its single ~130 KB `export { ... }`
 * statement is not fully re-exported by TypeScript under this project's
 * `verbatimModuleSyntax: true` config — a handful of names (e.g. `Sun`,
 * `Moon`, `Monitor`, `Check`, …) are reported as "no exported member".
 *
 * To unblock named imports without forking the package or downgrading the
 * tsconfig, we augment the module declaration with the few icons we actually
 * use that fall into that gap.
 */
import "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type { LucideProps } from "lucide-react";

declare module "lucide-react" {
  type LucideIconComponent = ForwardRefExoticComponent<
    Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
  >;

  export const Sun: LucideIconComponent;
  export const Moon: LucideIconComponent;
  export const Monitor: LucideIconComponent;
  export const Check: LucideIconComponent;
}
