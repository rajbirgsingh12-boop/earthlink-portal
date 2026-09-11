// The survey form: one PDF, the same every time, organized by what gets
// checked in a vacant apartment — windows, doors, electrical, kitchen,
// bathroom, walls and floors. Fill the count boxes on the phone (it is a
// real PDF form) or print it and write, then upload it on the Proposals tab.
// Because it is ours, the reader knows every box: a filled form is read
// straight off its fields, no guessing at the wording.
import { COMPANY } from "./company";
import { SEED_ITEMS } from "./surveyTemplate";

const FIELD = (key: string) => `q:${key}`;
const clean = (label: string) => label.replace(/\s*\(.*\)$/, "");
// what prints beside the box — short enough for a third of the page
const SHORT: Record<string, string> = {
  outlet_single: "Outlet single", outlet_double: "Outlet double (duplex)", cover_1: "Cover plate 1 gang", cover_2: "Cover plate 2 gang",
  light_pancake: "Ceiling light (pancake)", smoke_wired: "Smoke detector wired", smoke_battery: "Smoke detector battery", smoke_co: "Smoke / CO combo",
  lock_entrance: "Entrance lock / deadbolt", cylinder: "Lock cylinder / re-key", closet_shelf: "Closet shelf + pole", saddle: "Saddle / threshold", door_chain: "Door chain / guard",
  kitchen_plumbing: "Kitchen faucet / plumbing", kitchen_trap: "Kitchen trap / supplies", bath_accessories: "Bath accessories (3)", reglaze_both: "Reglaze tub + sink",
  bath_faucet: "Bathroom faucet", tub_faucet: "Tub / shower valve", lav_sink: "Bathroom sink", bath_tile_wall: "Bath wall tile", bath_tile_floor: "Bath floor tile",
  floor_tile: "Floor tile (VCT)", cove_base: "Cove base / baseboard", sheetrock: "Sheetrock patch",
};
const printed = (key: string, label: string) => SHORT[key] || clean(label);
// items on the form, in the order they are checked — the apartment-size lines are the header's Bedrooms box
export const FORM_ITEMS = SEED_ITEMS.filter((s) => !s.key.startsWith("apt_"));
const GROUP_ORDER = ["Apartment", "Windows", "Doors", "Electrical", "Kitchen", "Bathroom", "Walls & floors"];
const GROUP_TITLE: Record<string, string> = { Apartment: "Apartment", Windows: "Windows", Doors: "Doors & locks", Electrical: "Electrical", Kitchen: "Kitchen", Bathroom: "Bathroom", "Walls & floors": "Walls, ceilings & floors" };

export const SURVEY_FORM_NAME = "Earth Link move-out survey.pdf";

export async function buildSurveyFormPdf(logo?: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle("Move-out survey");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const INK = rgb(0.122, 0.137, 0.157), MUTED = rgb(0.43, 0.43, 0.40), BRAND = rgb(0.761, 0.290, 0.039), HAIR = rgb(0.80, 0.78, 0.74), WHITE = rgb(1, 1, 1);
  // three columns, so the whole apartment is one page
  const M = 36, W = 612 - 2 * M, COLS = 3, COL_GAP = 12, COL_W = (W - COL_GAP * (COLS - 1)) / COLS, ROW = 15, BOX_W = 36, BOX_H = 12.5;
  let page = doc.addPage([612, 792]);
  const text = (s: string, x: number, y: number, size: number, f = helv, color = INK) => page.drawText(s, { x, y, size, font: f, color });
  const box = (name: string, x: number, y: number, w: number, h: number, size = 9, multiline = false) => {
    const tf = form.createTextField(name);
    if (multiline) tf.enableMultiline();
    // on the page first — the field's appearance entry exists only after that, and the size is written into it
    tf.addToPage(page, { x, y, width: w, height: h, borderWidth: 0.75, borderColor: HAIR, backgroundColor: WHITE, font: helv });
    tf.setFontSize(size);
  };

  // ---- the head: who we are, what this is, where ----
  let y = 792 - M;
  let x = M;
  if (logo) {
    try { const img = await doc.embedPng(logo); const h = 30, w = (img.width / img.height) * h; page.drawImage(img, { x: M, y: y - h, width: w, height: h }); x = M + w + 10; } catch { /* no logo, no matter */ }
  }
  text(COMPANY.letterhead.name, x, y - 12, 12, bold);
  text("MOVE-OUT SURVEY", 612 - M - bold.widthOfTextAtSize("MOVE-OUT SURVEY", 16), y - 14, 16, bold, BRAND);
  text("Write the count in the box beside anything the apartment needs. A box left blank is not on the job.", x, y - 26, 8.5, helv, MUTED);
  y -= 44;
  page.drawLine({ start: { x: M, y }, end: { x: 612 - M, y }, thickness: 1.5, color: BRAND });
  y -= 22;
  // Address · Apt · MO/MI · Bedrooms · Date
  const heads: [string, string, number][] = [["Address", "hdr:address", 200], ["Apt", "hdr:apt", 58], ["MO / MI", "hdr:kind", 58], ["Bedrooms", "hdr:bedrooms", 58], ["Date", "hdr:date", 80]];
  let hx = M;
  for (const [label, name, w] of heads) {
    text(label.toUpperCase(), hx, y + 4, 7, bold, MUTED);
    box(name, hx, y - 14, w, 16, 10);
    hx += w + 8;
  }
  y -= 34;

  // ---- the items, two columns, grouped by what gets checked ----
  const groups = GROUP_ORDER.map((g) => ({ g, items: FORM_ITEMS.filter((it) => it.group === g) })).filter((x) => x.items.length);
  let col = 0;
  const colX = () => M + col * (COL_W + COL_GAP);
  let pageTop = y;
  const bottomLimit = 36 + 70; // room for the notes box at the foot
  const nextSlot = (need: number) => {
    if (y - need < bottomLimit) {
      if (col < COLS - 1) { col += 1; y = pageTop; }
      else { page = doc.addPage([612, 792]); col = 0; pageTop = 792 - M - 10; y = pageTop; }
    }
  };
  for (const { g, items } of groups) {
    nextSlot(ROW * 2.2);
    y -= 4;
    text(GROUP_TITLE[g].toUpperCase(), colX(), y - 8, 8.5, bold, BRAND);
    page.drawLine({ start: { x: colX(), y: y - 12 }, end: { x: colX() + COL_W, y: y - 12 }, thickness: 0.75, color: HAIR });
    y -= ROW + 2;
    for (const it of items) {
      nextSlot(ROW);
      const label = printed(it.key, it.label);
      const room = COL_W - BOX_W - 8;
      const size = helv.widthOfTextAtSize(label, 8.5) <= room ? 8.5 : helv.widthOfTextAtSize(label, 7.5) <= room ? 7.5 : 7;
      text(label, colX(), y - 9, size);
      const lw = helv.widthOfTextAtSize(label, size);
      if (lw + 10 < room) page.drawLine({ start: { x: colX() + lw + 4, y: y - 9.5 }, end: { x: colX() + COL_W - BOX_W - 4, y: y - 9.5 }, thickness: 0.35, color: HAIR, dashArray: [1, 2] });
      box(FIELD(it.key), colX() + COL_W - BOX_W, y - 11, BOX_W, BOX_H, 9);
      y -= ROW;
    }
  }
  // ---- anything else: the foot of the last page (the columns stop short of it) ----
  text("ANYTHING ELSE — write it with a count (e.g. \"closet door 2\")", M, 36 + 62, 7, bold, MUTED);
  box("notes", M, 36, W, 58, 9, true);
  text("Upload this on the Proposals tab and the walk sheet builds itself.", M, 22, 7, helv, MUTED);
  form.updateFieldAppearances(helv);
  return doc.save({ updateFieldAppearances: true });
}

// A filled copy of our form, read straight off its boxes into the survey
// shorthand the reader already understands. Null when the PDF isn't our form.
export async function readSurveyForm(bytes: Uint8Array): Promise<string | null> {
  const { PDFDocument } = await import("pdf-lib");
  let form: import("pdf-lib").PDFForm;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    form = doc.getForm();
  } catch { return null; }
  let fields: import("pdf-lib").PDFField[];
  try { fields = form.getFields(); } catch { return null; }
  if (!fields.some((f) => f.getName().startsWith("q:"))) return null;
  const get = (name: string) => { try { return (form.getTextField(name).getText() || "").trim(); } catch { return ""; } };
  const out: string[] = [];
  const address = get("hdr:address"), apt = get("hdr:apt"), kind = get("hdr:kind");
  if (address) out.push([address, apt, kind || "MO"].filter(Boolean).join(" "));
  const br = get("hdr:bedrooms").match(/\d+/)?.[0];
  if (br) out.push(`${br} bedroom`);
  for (const it of FORM_ITEMS) {
    const v = get(FIELD(it.key));
    if (v) out.push(`${clean(it.label)}: ${v}`);
  }
  const notes = get("notes");
  if (notes) out.push(...notes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return out.join("\n");
}
