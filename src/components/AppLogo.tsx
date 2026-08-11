const LOGO_SRC = "/logo.jpg";

type Props = {
  className?: string;
  /** Sidebar / header icon vs login hero lockup */
  variant?: "mark" | "lockup";
};

export function AppLogo({ className = "", variant = "mark" }: Props) {
  return (
    <img
      src={LOGO_SRC}
      alt="Nexus"
      width={variant === "lockup" ? 200 : 40}
      height={variant === "lockup" ? 200 : 40}
      className={[
        "object-contain",
        variant === "lockup" ? "h-auto w-full max-w-[11rem]" : "h-full w-full",
        className,
      ].join(" ")}
      decoding="async"
    />
  );
}
