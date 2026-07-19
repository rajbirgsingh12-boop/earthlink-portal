import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1A1D21",
        paper: "#F6F4EF",
        card: "#FCFBF8",
        rule: "#C9C4B8",
        rulesoft: "#E2DED4",
        work: "#E8611C",
        ok: "#2E7D4F",
        carbon: "#33566E",
        alert: "#B3261E",
        inksoft: "#6B6B63",
      },
      fontFamily: {
        display: ["'Barlow Condensed'", "sans-serif"],
        mono: ["'IBM Plex Mono'", "monospace"],
        body: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
