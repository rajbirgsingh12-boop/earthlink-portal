// The work line, put into Spanish by Claude — the same key the PO reader
// uses. Server-only. Both /api/translate (the phone asking as the office
// types) and /api/text-due (a text going out on its own) come through here,
// so a scheduled text reads the same as one sent by hand. When Claude can't
// answer, the built-in glossary stands in and the text still goes out whole.
import { smartClient, smartConfigured } from "./smartPo";
import { roughSpanish } from "./spanish";

export const TRANSLATE_SYSTEM = `You translate short work descriptions from partner purchase orders into Spanish for construction laborers in New York City (plaster, paint, doors, floors, kitchens, bathrooms). Write plain, natural Spanish the way a foreman in Brooklyn would say it — usted, no slang, no explanations. Keep the same order and every detail: rooms, counts, apartment or unit labels (like 11A, 2nd floor), measurements, product names and anything in parentheses. Keep "move-out" as it is. Do not add anything. Answer with the translation only.`;

// Claude's Spanish for this line, or null when it can't be had
export async function askClaudeSpanish(text: string, timeoutMs = 20_000): Promise<string | null> {
  const client = await smartClient(timeoutMs);
  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 600,
    system: TRANSLATE_SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  const out = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
  return out || null;
}
// never throws: Claude's Spanish, else the glossary's
export async function spanishWorkServer(text: string, ask = askClaudeSpanish): Promise<string> {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!smartConfigured()) return roughSpanish(t);
  try { return (await ask(t)) || roughSpanish(t); } catch { return roughSpanish(t); }
}
