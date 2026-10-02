"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { isValidEmail } from "@/lib/utils";

export interface FieldDef {
  name: string;
  label: string;
  type: "text" | "email" | "number" | "tel" | "password" | "select" | "textarea" | "date" | "switch";
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  step?: string;
  min?: number;
  max?: number;
  defaultValue?: string | number | boolean;
  full?: boolean;
  hint?: string;
}

export type FormValues = Record<string, string | number | boolean | null>;

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  fields: FieldDef[];
  values?: FormValues;
  submitLabel?: string;
  onSubmit: (values: FormValues) => Promise<void>;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  fields,
  values,
  submitLabel = "Save",
  onSubmit,
}: FormDialogProps) {
  const [form, setForm] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const initial: FormValues = {};
      for (const f of fields) {
        const v = values?.[f.name];
        initial[f.name] = v !== undefined && v !== null ? v : (f.defaultValue ?? (f.type === "switch" ? false : ""));
      }
      setForm(initial);
      setErrors({});
      setSubmitError(null);
    }
  }, [open, values]);

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const v = form[f.name];
      if (f.required && (v === "" || v === null || v === undefined)) {
        errs[f.name] = `${f.label} is required.`;
        continue;
      }
      if (f.type === "email" && typeof v === "string" && v && !isValidEmail(v)) {
        errs[f.name] = "Enter a valid email address.";
        continue;
      }
      if (f.type === "number" && typeof v === "string" && v !== "") {
        const n = Number(v);
        if (Number.isNaN(n)) errs[f.name] = "Enter a valid number.";
        else if (f.min !== undefined && n < f.min) errs[f.name] = `Must be at least ${f.min}.`;
        else if (f.max !== undefined && n > f.max) errs[f.name] = `Must be at most ${f.max}.`;
      }
      if (f.type === "tel" && typeof v === "string" && v && !/^[0-9+\-\s()]{7,20}$/.test(v)) {
        errs[f.name] = "Enter a valid phone number.";
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const cleaned: FormValues = {};
      for (const [k, v] of Object.entries(form)) {
        const field = fields.find((f) => f.name === k);
        cleaned[k] = field?.type === "number" && typeof v === "string" && v !== "" ? Number(v) : v;
      }
      await onSubmit(cleaned);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!submitting ? onOpenChange(o) : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-thin sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.name} className={f.full || f.type === "textarea" ? "sm:col-span-2" : ""}>
                {f.type === "switch" ? (
                  <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                    <Label htmlFor={`f-${f.name}`} className="cursor-pointer">
                      {f.label}
                    </Label>
                    <Switch
                      id={`f-${f.name}`}
                      checked={!!form[f.name]}
                      onCheckedChange={(checked) => setForm((s) => ({ ...s, [f.name]: checked }))}
                    />
                  </div>
                ) : (
                  <>
                    <Label htmlFor={`f-${f.name}`} className="mb-1.5 block">
                      {f.label}
                      {f.required ? <span className="text-rose-500"> *</span> : null}
                    </Label>
                    {f.type === "select" ? (
                      <Select
                        value={String(form[f.name] ?? "")}
                        onValueChange={(v) => setForm((s) => ({ ...s, [f.name]: v }))}
                      >
                        <SelectTrigger id={`f-${f.name}`} className="w-full">
                          <SelectValue placeholder={f.placeholder ?? `Select ${f.label.toLowerCase()}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {(f.options ?? []).map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : f.type === "textarea" ? (
                      <Textarea
                        id={`f-${f.name}`}
                        rows={3}
                        value={String(form[f.name] ?? "")}
                        placeholder={f.placeholder}
                        onChange={(e) => setForm((s) => ({ ...s, [f.name]: e.target.value }))}
                      />
                    ) : (
                      <Input
                        id={`f-${f.name}`}
                        type={f.type === "number" ? "number" : f.type === "date" ? "date" : f.type}
                        step={f.step}
                        min={f.min}
                        max={f.max}
                        inputMode={f.type === "number" ? "decimal" : f.type === "tel" ? "tel" : undefined}
                        value={String(form[f.name] ?? "")}
                        placeholder={f.placeholder}
                        onChange={(e) => setForm((s) => ({ ...s, [f.name]: e.target.value }))}
                      />
                    )}
                    {errors[f.name] ? (
                      <p className="mt-1 text-xs text-rose-600">{errors[f.name]}</p>
                    ) : f.hint ? (
                      <p className="mt-1 text-xs text-muted-foreground">{f.hint}</p>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>

          {submitError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {submitError}
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
