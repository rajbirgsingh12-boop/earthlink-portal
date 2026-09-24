// The company logo's colors, for the proposals: the banner's dark brown, the
// globe's ocean teal and land green, and the copper of the tan ribbon
// (darkened a shade so small labels in it stay readable on the cream).
// Hex for the .docx and the screen, 0–1 RGB for pdf-lib.
export const LOGO_HEX = {
  brown: "3A2B19",
  teal: "10728C",
  green: "516F11",
  tan: "8A633C",
  ink: "2B231B",     // body text
  muted: "70665A",   // second lines, codes, unit prices
  cream: "F6F2EA",   // the band behind the job details and table headers
  hair: "E2DACD",    // the line between two rows
} as const;

export type Rgb = readonly [number, number, number];
const toRgb = (h: string): Rgb => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;
export const LOGO_RGB = Object.fromEntries(Object.entries(LOGO_HEX).map(([k, v]) => [k, toRgb(v)])) as Record<keyof typeof LOGO_HEX, Rgb>;
