import { useId, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

export function Field({ label, description, children, locked }: { label: string; description?: string; children: ReactNode; locked?: string }) {
  return <div className="space-y-1.5"><div className="text-sm font-medium">{label}</div>{children}{description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}{locked && <p className="text-xs text-muted-foreground">Locked by {locked}.</p>}</div>;
}
export function TextField({ label, value, onChange, description, locked, secret = false, multiline = false }: { label: string; value: string; onChange: (v: string) => void; description?: string; locked?: string; secret?: boolean; multiline?: boolean }) {
  const id = useId(); const props = { id, "aria-label": label, "aria-describedby": `${id}-help`, value, disabled: !!locked, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  return <div className="max-w-xl space-y-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label>{multiline ? <Textarea {...props} rows={4} spellCheck={false} /> : <Input {...props} type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} spellCheck={false} />}<p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">{locked ? `Locked by ${locked}. ` : ""}{description}</p></div>;
}
export function SelectField({ label, value, onChange, options, description, locked }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; description?: string; locked?: string }) {
  const id = useId();
  return <div className="max-w-xl space-y-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label><NativeSelect id={id} aria-label={label} aria-describedby={`${id}-help`} value={value} disabled={!!locked} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect><p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">{locked ? `Locked by ${locked}. ` : ""}{description}</p></div>;
}
export function ToggleField({ label, value, onChange, description, locked }: { label: string; value: boolean; onChange: (v: boolean) => void; description?: string; locked?: string }) {
  const id = useId();
  return <div className="space-y-1"><label className="flex items-center gap-2 text-sm font-medium"><input id={id} type="checkbox" checked={value} disabled={!!locked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-help`} className="size-4 accent-primary" />{label}</label><p id={`${id}-help`} className="pl-6 text-xs leading-relaxed text-muted-foreground">{locked ? `Locked by ${locked}. ` : ""}{description}</p></div>;
}
export function NumberField({ label, value, onChange, description, locked, nullable = false, min = 0, step = 1 }: { label: string; value: number | null; onChange: (v: number | null) => void; description?: string; locked?: string; nullable?: boolean; min?: number; step?: number }) {
  const id = useId();
  return <div className="space-y-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label><Input id={id} aria-label={label} aria-describedby={`${id}-help`} type="number" min={min} step={step} required={!nullable} value={value ?? ""} disabled={!!locked} onChange={(e) => onChange(e.target.value === "" && nullable ? null : Number(e.target.value))} className="max-w-64" /><p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">{locked ? `Locked by ${locked}. ` : ""}{description}{nullable ? " Leave blank for no configured limit." : ""}</p></div>;
}
export function Group({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <section className="space-y-5 border-b border-border pb-7 last:border-0"><div><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>}</div>{children}</section>;
}
