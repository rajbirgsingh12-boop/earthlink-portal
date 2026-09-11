// How a move-out apartment is billed on NYCHA's move-out contract — taken
// line for line from a release we were paid on (Blanket Release 2442583-332,
// Van Dyke, August 2026). A survey becomes these lines and nothing else: the
// ten "Provide and install" lines the contract has for what comes up in every
// vacant apartment, and General Laborer hours for everything else (locks,
// wax, the toilet, hooking up the stove…). The prices carry the bid factor,
// the way the release prints them; the contract's own price book wins when
// it has the line. When NYCHA issues a new move-out contract, it changes here.
export const MOVEOUT_CONTRACT = "2442583";
export const MOVEOUT_RELEASE = "2442583-332";

export interface ReleaseLine { line: number; code: string; description: string; uom: string; unit_price: number; category: string }

export const CODE = {
  rod: "062001379", med: "062001380", balance: "062001383", combo: "062001410", circline: "062001385",
  keyless: "062001386", gfi: "062001392", switches: "062001393", tub: "062001145", sink: "062001342", labor: "062001840",
} as const;

const R = (line: number, code: string, description: string, uom: string, unit_price: number): ReleaseLine => ({ line, code, description, uom, unit_price, category: "Move-out" });
export const RELEASE_LINES: ReleaseLine[] = [
  R(36, CODE.rod, "Provide and install shower rod and mounting kit (Labor & Material)", "EACH", 112.53),
  R(37, CODE.med, "Provide and install medicine cabinet (Labor & Material)", "EACH", 379.32),
  R(51, CODE.balance, "Provide and install window balances (Labor & Material)", "EACH", 73.34),
  R(52, CODE.combo, "Provide and install C02/Smoke Alarm Combo Unit", "EACH", 189.66),
  R(53, CODE.circline, "Provide and install ceiling light fixture, fluorescent 22W-32W Circle-line (Labor & Material)", "EACH", 202.30),
  R(54, CODE.keyless, "Provide and install ceiling light fixture, keyless porcelain (Labor & Material)", "EACH", 132.76),
  R(59, CODE.gfi, "Provide and install GFI outlets in kitchen and bathroom (Labor & Material)", "EACH", 101.15),
  R(60, CODE.switches, "Provide and install electrical light switches and outlets (Labor & Material)", "EACH", 87.24),
  R(148, CODE.tub, "Re-glazing work (primer, topcoat; etc.)", "EACH", 1007.73),
  R(149, CODE.sink, "Re-glazing work for sink", "EACH", 571.51),
  R(298, CODE.labor, "General Laborer Tier A, Regular Hours", "HOUR", 107),
];
export const releaseLine = (code: string): ReleaseLine | undefined => RELEASE_LINES.find((r) => r.code === code);
