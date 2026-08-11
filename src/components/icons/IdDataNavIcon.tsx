import { forwardRef, type SVGProps } from "react";

/**
 * ID card outline (paths aligned with lucide-react’s IdCard).
 * Defined locally so production builds do not depend on barrel exports
 * that differ across lucide-react versions / install layouts.
 */
export const IdDataNavIcon = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(
  function IdDataNavIcon({ className, ...props }, ref) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        {...props}
      >
        <path d="M16 10h2" />
        <path d="M16 14h2" />
        <path d="M6.17 15a3 3 0 0 1 5.66 0" />
        <circle cx="9" cy="11" r="2" />
        <rect x="2" y="5" width="20" height="14" rx="2" />
      </svg>
    );
  },
);
