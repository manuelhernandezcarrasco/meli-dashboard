import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export const inputCls =
  "h-8 w-full min-w-0 rounded-md border border-line bg-card px-2 text-[13px] text-ink outline-none focus:border-blue";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-mut">
      <span className="font-semibold">{label}</span>
      {children}
      {hint ? <span className="font-normal">{hint}</span> : null}
    </label>
  );
}

export function TextInput(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`${inputCls} ${p.className ?? ""}`} />;
}

export function Btn({ kind = "ghost", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "danger" }) {
  const tone =
    kind === "primary" ? "border-navy bg-navy text-card"
    : kind === "danger" ? "border-line bg-card text-neg"
    : "border-line bg-card text-ink";
  return (
    <button
      type="button"
      {...p}
      className={`h-8 cursor-pointer whitespace-nowrap rounded-md border px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50 ${tone} ${p.className ?? ""}`}
    />
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return children ? <p role="alert" className="m-0 text-xs text-neg">{children}</p> : null;
}
