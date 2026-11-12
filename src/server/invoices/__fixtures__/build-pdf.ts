/** Test helper: builds a minimal one-font text PDF from positioned strings. Not shipped code. */
export interface PdfText {
  x: number;
  y: number;
  text: string;
}

export function buildPdf(pages: PdfText[][]): Buffer {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  pages.forEach((items, i) => {
    const stream = items
      .map((t) => `BT /F1 8 Tf 1 0 0 1 ${t.x} ${t.y} Tm (${t.text.replace(/[\\()]/g, "\\$&")}) Tj ET`)
      .join("\n");
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** A synthetic Sony-layout invoice (same row structure as the real sample) with overridable numbers. */
export function sonyLikePdf(o: { total?: string; subtotal?: string; lineSubtotal?: string; noLines?: boolean } = {}): Buffer {
  const head: PdfText[] = [
    { x: 400, y: 700, text: "Nº 0225-00099999" },
    { x: 30, y: 690, text: "Sony Argentina S.A." },
    { x: 400, y: 670, text: "FECHA: 01/09/2026" },
    { x: 400, y: 650, text: "CUIT Nº: 30679928879" },
    { x: 100, y: 560, text: "CODIGO DE CUENTA" },
    { x: 400, y: 550, text: "30715331671" },
  ];
  const table: PdfText[] = [{ x: 30, y: 500, text: "CANTIDAD   CODIGO   DESCRIPCION" }];
  if (!o.noLines) {
    table.push(
      { x: 40, y: 480, text: "2" },
      { x: 90, y: 480, text: "11111111" },
      { x: 300, y: 480, text: "WH-TEST/AB UC" },
      { x: 180, y: 469, text: "027242925489" },
      { x: 300, y: 469, text: "100,00" },
      { x: 380, y: 469, text: "200,00" },
      { x: 450, y: 469, text: "0,00" },
      { x: 500, y: 469, text: o.lineSubtotal ?? "200,00" },
    );
  }
  table.push({ x: 150, y: 440, text: `Subtotale   ${o.subtotal ?? "200,00"}   0,00   ${o.subtotal ?? "200,00"}` });
  const totals: PdfText[] = [
    { x: 42, y: 321, text: "Perc. IB CF 6.000 %" },
    { x: 160, y: 321, text: "IVA 21 %" },
    { x: 74, y: 313, text: "12,00" },
    { x: 154, y: 313, text: "42,00" },
    { x: 542, y: 211, text: "TOTAL PESOS" },
    { x: 547, y: 201, text: o.total ?? "254,00" },
  ];
  return buildPdf([[...head, ...table, ...totals]]);
}
