// Server-only: a PO's PDF read into its fields — the rules first, Claude on
// top when the smart reader is switched on (lib/smartPo). /api/parse-po
// reads a PDF the phone just picked; /api/fix-descriptions re-reads the
// PDFs already on the jobs. unpdf bundles a serverless-safe pdf engine.
import { type PoItem } from "./parsePactPo";
import { readPoOrProposalPages } from "./parsePactProposal";
import { readPoSmart, type SmartRead } from "./smartPo";

export async function readPoBytes(buf: ArrayBuffer, timeoutMs?: number): Promise<SmartRead> {
  const { getResolvedPDFJS } = await import("unpdf");
  const pdfjs = await getResolvedPDFJS();
  // pdfjs takes the buffer it is handed and detaches it — it gets a copy,
  // so the bytes still exist for the smart reader afterwards
  const bytes = new Uint8Array(buf);
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pages: PoItem[][] = [];
  for (let pg = 1; pg <= doc.numPages; pg++) {
    const tc = await (await doc.getPage(pg)).getTextContent();
    pages.push(tc.items as PoItem[]);
  }
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => null);
  const rules = readPoOrProposalPages(pages);
  // readPoSmart only ever shows Claude a partner PO — releases, payroll,
  // statements and anything else stay with the rules
  const text = pages.map((it) => it.map((x) => x.str || "").join(" ")).join("\n");
  return readPoSmart(bytes, text, rules, undefined, timeoutMs);
}
