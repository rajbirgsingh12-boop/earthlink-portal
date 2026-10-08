import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  // a phone has no hover: without this, a tapped button keeps its hover look
  // until the next tap somewhere else, which is the "stuck" feel
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        // the logo's own colors (lib/logoColors.ts): the banner's dark brown is the
        // ink, the ocean teal the accent, the land green the "ok", the copper
        // ribbon the quiet third tone, and the cream the paper
        ink: "#2B231B",
        paper: "#F6F2EA",
        card: "#FCFAF5",
        rule: "#CFC6B6",
        rulesoft: "#E2DACD",
        work: "#10728C",
        ok: "#516F11",
        carbon: "#8A633C",
        alert: "#B3261E",
        inksoft: "#70665A",
        papersoft: "#A9A69C", // the quiet text on the dark header
        // the logo's colors (lib/logoColors.ts) — the proposals are drawn in these
        logo: { brown: "#3A2B19", teal: "#10728C", green: "#516F11", tan: "#8A633C", ink: "#2B231B", muted: "#70665A", cream: "#F6F2EA", hair: "#E2DACD" },
      },
      fontFamily: {
        display: ["var(--font-display)", "'Barlow Condensed'", "sans-serif"],
        mono: ["var(--font-mono)", "'IBM Plex Mono'", "monospace"],
        body: ["var(--font-body)", "Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
