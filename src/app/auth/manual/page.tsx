import { redirect } from "next/navigation";
import { extractCode } from "~/server/ml/oauth";
import { exchangeCode } from "~/server/ml/tokens";

async function submit(formData: FormData) {
  "use server";
  const code = extractCode(String(formData.get("code") ?? ""));
  if (!code) redirect("/auth/manual?error=1");
  try {
    await exchangeCode(code);
  } catch {
    redirect("/auth/manual?error=1");
  }
  redirect("/");
}

export default async function ManualAuthPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-xl space-y-4 p-8 text-white">
      <h1 className="text-2xl font-bold">Autorizar Mercado Libre (manual)</h1>
      <p className="text-sm text-slate-300">
        Pegá la URL completa a la que te redirigió Mercado Libre (o solo el código
        TG-…).
      </p>
      <form action={submit} className="space-y-3">
        <textarea
          name="code"
          rows={3}
          required
          className="w-full rounded bg-slate-800 p-2 text-sm"
        />
        <button type="submit" className="rounded bg-blue-600 px-4 py-2">
          Autorizar
        </button>
      </form>
      {error && (
        <p className="text-sm text-red-400">No se pudo autorizar. Revisá el código.</p>
      )}
    </main>
  );
}
