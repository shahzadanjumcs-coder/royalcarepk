"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, buildQuery, useDebounced, useList } from "@/lib/client";
import { PageHeader } from "./states";
import { SearchInput } from "./filters";
import { DataTable, type Column } from "./data-table";
import { FormDialog, type FieldDef, type FormValues } from "./form-dialog";
import { ConfirmDialog } from "./confirm-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";

export interface ResourceManagerProps<T extends { id: string }> {
  title: string;
  description?: string;
  /** list endpoint (relative, e.g. /api/products) */
  endpoint: string;
  columns: Column<T>[];
  fields: FieldDef[];
  emptyTitle: string;
  emptyDescription?: string;
  searchPlaceholder?: string;
  searchFields?: string[];
  mapRowToForm?: (row: T) => FormValues;
  transformSubmit?: (values: FormValues, mode: "create" | "edit") => Record<string, unknown>;
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  createLabel?: string;
  toolbar?: React.ReactNode;
  rowHref?: (row: T) => string;
  mobileCard?: (row: T) => React.ReactNode;
  /** override default create */
  onCreate?: (values: FormValues) => Promise<void>;
  /** override default edit */
  onUpdate?: (row: T, values: FormValues) => Promise<void>;
  /** override default delete (return a message to show nothing) */
  onDelete?: (row: T) => Promise<string | void>;
}

export function ResourceManager<T extends { id: string }>(props: ResourceManagerProps<T>) {
  const {
    title, description, endpoint, columns, fields, emptyTitle, emptyDescription,
    searchPlaceholder = "Search…", searchFields = [], mapRowToForm, transformSubmit,
    canCreate = true, canEdit = true, canDelete = true, createLabel, toolbar,
    rowHref, mobileCard, onCreate, onUpdate, onDelete,
  } = props;

  const router = useRouter();
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [deleting, setDeleting] = useState<T | null>(null);

  const qs = buildQuery({ search: debounced, page, perPage: 15 });
  const { data, loading, error, refresh } = useList<T>(`${endpoint}${qs}`, [debounced, page]);

  const submit = async (values: FormValues) => {
    const payload = transformSubmit ? transformSubmit(values, editing ? "edit" : "create") : values;
    try {
      if (editing) {
        if (onUpdate) await onUpdate(editing, payload as FormValues);
        else await api(`${endpoint}/${editing.id}`, { method: "PATCH", json: payload });
      } else {
        if (onCreate) await onCreate(payload as FormValues);
        else await api(endpoint, { method: "POST", json: payload });
      }
      refresh();
      router.refresh();
    } catch (e) {
      throw e instanceof ApiError ? e : new Error("Save failed. Please try again.");
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      if (onDelete) await onDelete(deleting);
      else await api(`${endpoint}/${deleting.id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      throw e instanceof ApiError ? e : new Error("Delete failed.");
    }
  };

  const actionColumn: Column<T> = {
    key: "__actions",
      header: "",
      hideInCard: true,
      headerClassName: "w-10",
      render: (row) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" aria-label="Row actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {rowHref ? (
              <DropdownMenuItem onClick={() => router.push(rowHref(row))}>View details</DropdownMenuItem>
            ) : null}
            {canEdit ? (
              <DropdownMenuItem
                onClick={() => {
                  setEditing(row);
                  setDialogOpen(true);
                }}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
              </DropdownMenuItem>
            ) : null}
            {canDelete ? (
              <DropdownMenuItem className="text-rose-600 focus:text-rose-600" onClick={() => setDeleting(row)}>
                <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
};
  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={description}
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-1.5 h-4 w-4" /> {createLabel ?? "Add"}
            </Button>
          ) : null
        }
      />

      <DataTable
        columns={[...columns, actionColumn]}
        rows={data?.rows}
        loading={loading}
        error={error}
        onRetry={refresh}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        page={page}
        perPage={15}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onRowClick={rowHref ? (row) => router.push(rowHref(row)) : undefined}
        toolbar={
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            {searchFields.length ? (
              <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder={searchPlaceholder} className="lg:w-80" />
            ) : <div />}
            {toolbar}
          </div>
        }
        mobileCard={mobileCard}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? `Edit ${title.replace(/s$/, "")}` : createLabel ?? `Add ${title.replace(/s$/, "")}`}
        fields={fields}
        values={editing && mapRowToForm ? mapRowToForm(editing) : undefined}
        submitLabel={editing ? "Save changes" : "Create"}
        onSubmit={submit}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this record?"
        description="This action cannot be undone. Records with history may be disabled instead of deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}
