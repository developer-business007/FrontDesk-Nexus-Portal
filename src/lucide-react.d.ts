/** Fallback: some installs ship lucide-react without dist/*.d.ts; satisfies strict TS. */
declare module "lucide-react" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";
  export type LucideIcon = ForwardRefExoticComponent<
    SVGProps<SVGSVGElement> & RefAttributes<SVGSVGElement>
  >;
  export const LayoutDashboard: LucideIcon;
  export const LayoutGrid: LucideIcon;
  export const CalendarRange: LucideIcon;
  export const Ban: LucideIcon;
  export const Wallet: LucideIcon;
  export const BarChart3: LucideIcon;
  export const Users: LucideIcon;
  export const Settings: LucideIcon;
  export const LogOut: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronUp: LucideIcon;
  export const Search: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const Eye: LucideIcon;
  export const Pencil: LucideIcon;
  export const Trash2: LucideIcon;
  export const Download: LucideIcon;
  export const FileText: LucideIcon;
  export const ExternalLink: LucideIcon;
  export const Loader2: LucideIcon;
  export const X: LucideIcon;
  export const Mail: LucideIcon;
  export const Phone: LucideIcon;
  export const ArrowUp: LucideIcon;
  export const ArrowDown: LucideIcon;
  export const ChevronsLeft: LucideIcon;
  export const ChevronsRight: LucideIcon;
  export const ChevronLeft: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const ArrowLeft: LucideIcon;
  export const Clock: LucideIcon;
  export const ScanLine: LucideIcon;
  export const ScrollText: LucideIcon;
  export const Activity: LucideIcon;
  export const Calendar: LucideIcon;
  export const Lock: LucideIcon;
  export const LockOpen: LucideIcon;
  export const KeyRound: LucideIcon;
  export const Save: LucideIcon;
  export const ClipboardList: LucideIcon;
  export const Table2: LucideIcon;
  export const Bell: LucideIcon;
  export const Wrench: LucideIcon;
  export const Monitor: LucideIcon;
  export const Paperclip: LucideIcon;
  export const Plus: LucideIcon;
  export const ClipboardCheck: LucideIcon;
  export const ListFilter: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const IdCard: LucideIcon;
}
