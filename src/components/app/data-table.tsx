"use client";

import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, type LucideIcon, Inbox } from "lucide-react";
import { EmptyState, ErrorState, LoadingRows } from "./states";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
  headerClassName?: string;
  /** hide this column in the mobile card view */
  hideInCard?: boolean;
}

interface DataTableProps<T extends { id: string }> {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: LucideIcon;
  page?: number;
  perPage?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  toolbar?: React.ReactNode;
  mobileCard?: (row: T) => React.ReactNode;
  rowAction?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  error,
  onRetry,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyIcon,
  page = 1,
  perPage = 15,
  total = 0,
  onPageChange,
  toolbar,
  mobileCard,
  rowAction,
  onRowClick,
}: DataTableProps<T>) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = Math.min(total, page * perPage);

  if (error) {
    return (
      <div className="space-y-3">
        {toolbar}
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar ? <div className="no-print">{toolbar}</div> : null}

      {loading ? (
        <div className="rounded-xl border border-border bg-card">
          <LoadingRows rows={6} />
        </div>
      ) : !rows || rows.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} icon={emptyIcon} />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    {columns.map((c) => (
                      <TableHead key={c.key} className={cn("whitespace-nowrap font-semibold", c.headerClassName)}>
                        {c.header}
                      </TableHead>
                    ))}
                    {rowAction ? <TableHead className="w-10" /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className={cn(onRowClick && "cursor-pointer")}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {columns.map((c) => (
                        <TableCell key={c.key} className={cn("align-middle", c.className)}>
                          {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "—")}
                        </TableCell>
                      ))}
                      {rowAction ? (
                        <TableCell onClick={(e) => e.stopPropagation()} className="text-right">
                          {rowAction(row)}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {mobileCard
              ? rows.map((row) => <div key={row.id}>{mobileCard(row)}</div>)
              : rows.map((row) => (
                  <div
                    key={row.id}
                    className={cn("rounded-xl border border-border bg-card p-4", onRowClick && "active:bg-muted/50")}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    role={onRowClick ? "button" : undefined}
                  >
                    <div className="space-y-1.5">
                      {columns
                        .filter((c) => !c.hideInCard)
                        .slice(0, 6)
                        .map((c) => (
                          <div key={c.key} className="flex items-start justify-between gap-3 text-sm">
                            <span className="shrink-0 text-muted-foreground">{c.header}</span>
                            <span className="text-right font-medium text-foreground">
                              {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "—")}
                            </span>
                          </div>
                        ))}
                    </div>
                    {rowAction ? <div className="mt-3 flex justify-end">{rowAction(row)}</div> : null}
                  </div>
                ))}
          </div>

          {/* Pagination */}
          {onPageChange && total > 0 ? (
            <div className="flex flex-col gap-3 sm:flex-row items-center justify-between no-print">
              <p className="text-sm text-muted-foreground">
                Showing <span className="font-medium text-foreground">{start}–{end}</span> of{" "}
                <span className="font-medium text-foreground">{total}</span>
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </Button>
                <span className="text-sm text-muted-foreground px-1">
                  {page} / {totalPages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export { Inbox };
