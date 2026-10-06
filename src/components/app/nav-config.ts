import { LayoutDashboard, Package, ShoppingCart, Users, HardHat, Network, PercentCircle, Wallet, Boxes, Tags, Building2, Truck, Radar, BookOpen, BarChart3, Bell, ScrollText, Settings, MapPin, Globe, Handshake, ArrowDownToLine, ArrowUpFromLine, History, ClipboardList, ClipboardCheck, FileSpreadsheet, Landmark, MessageCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Role } from "@/lib/types";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** exact match for active state */
  exact?: boolean;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
  /** When set, the section is only shown to these roles (admin sidebar). */
  roles?: Role[];
}

export const ADMIN_NAV: NavSection[] = [
  {
    title: null,
    items: [{ label: "Dashboard", href: "/admin", icon: LayoutDashboard, exact: true }],
  },
  {
    title: "Orders",
    // order detail/create pages call /api/lookup, which excludes inventory_manager
    roles: ["super_admin", "admin"],
    items: [
      { label: "All Orders", href: "/admin/orders", icon: ShoppingCart },
      { label: "Pending Approvals", href: "/admin/orders?approval=PENDING", icon: ClipboardCheck },
      { label: "Pending", href: "/admin/orders?status=PENDING", icon: ClipboardList },
      { label: "Booked", href: "/admin/orders?status=BOOKED", icon: BookOpen },
      { label: "In Transit", href: "/admin/orders?status=IN_TRANSIT", icon: Truck },
      { label: "Delivered", href: "/admin/orders?status=DELIVERED", icon: Package },
      { label: "Returned", href: "/admin/orders?status=RETURNED", icon: ArrowUpFromLine },
      { label: "Cancelled", href: "/admin/orders?status=CANCELLED", icon: FileSpreadsheet },
    ],
  },
  {
    title: "Team",
    roles: ["super_admin", "admin"],
    items: [
      { label: "Workers", href: "/admin/workers", icon: HardHat },
      { label: "Teams", href: "/admin/teams", icon: Users },
      { label: "Assignments", href: "/admin/assignments", icon: Network },
      { label: "Commission", href: "/admin/commission", icon: PercentCircle },
      { label: "Worker Payments", href: "/admin/worker-payments", icon: Wallet },
    ],
  },
  {
    title: "Customers",
    roles: ["super_admin", "admin"], // customer writes are admin-only
    items: [{ label: "All Customers", href: "/admin/customers", icon: Handshake }],
  },
  {
    title: "Inventory",
    items: [
      { label: "Products", href: "/admin/products", icon: Boxes },
      { label: "Categories", href: "/admin/categories", icon: Tags },
      { label: "Current Stock", href: "/admin/inventory", icon: Landmark },
      { label: "Stock In", href: "/admin/inventory/stock-in", icon: ArrowDownToLine },
      { label: "Stock Out", href: "/admin/inventory/stock-out", icon: ArrowUpFromLine },
      { label: "Returns", href: "/admin/inventory/returns", icon: History },
      { label: "Suppliers", href: "/admin/suppliers", icon: Building2 },
      { label: "Stock History", href: "/admin/inventory/history", icon: ScrollText },
    ],
  },
  {
    title: "Flaship",
    roles: ["super_admin", "admin"], // booking/sync/config APIs are admin-only
    items: [
      { label: "Booking", href: "/admin/flaship/booking", icon: BookOpen },
      { label: "Tracking", href: "/admin/flaship/tracking", icon: Radar },
      { label: "Couriers", href: "/admin/flaship/couriers", icon: Truck },
      { label: "Cities", href: "/admin/flaship/cities", icon: Globe },
      { label: "Pickup Locations", href: "/admin/flaship/pickups", icon: MapPin },
    ],
  },
  {
    title: "WhatsApp",
    roles: ["super_admin", "admin"],
    items: [{ label: "WhatsApp Bot", href: "/admin/whatsapp", icon: MessageCircle }],
  },
  {
    title: "Accounts",
    roles: ["super_admin", "admin"],
    items: [
      { label: "Worker Earnings", href: "/admin/accounts/earnings", icon: PercentCircle },
      { label: "Payments", href: "/admin/accounts/payments", icon: Wallet },
      { label: "Pending Payments", href: "/admin/accounts/pending", icon: ClipboardList },
      { label: "Transactions", href: "/admin/accounts/transactions", icon: ScrollText },
    ],
  },
  {
    title: "Insights",
    roles: ["super_admin", "admin"], // reports + audit logs are admin-only APIs
    items: [
      { label: "Reports", href: "/admin/reports", icon: BarChart3 },
      { label: "Notifications", href: "/admin/notifications", icon: Bell },
      { label: "Audit Logs", href: "/admin/audit-logs", icon: ScrollText },
    ],
  },
  {
    title: "System",
    roles: ["super_admin", "admin"],
    items: [{ label: "Settings", href: "/admin/settings", icon: Settings }],
  },
];

export const WORKER_NAV: NavItem[] = [
  { label: "Dashboard", href: "/worker", icon: LayoutDashboard, exact: true },
  { label: "My Orders", href: "/worker/orders", icon: ShoppingCart },
  { label: "New Order", href: "/worker/orders/new", icon: ClipboardList },
  { label: "Earnings", href: "/worker/earnings", icon: PercentCircle },
  { label: "Payments", href: "/worker/payments", icon: Wallet },
  { label: "Profile", href: "/worker/profile", icon: Users },
];
