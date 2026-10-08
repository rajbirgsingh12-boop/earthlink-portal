import type { MetadataRoute } from "next";

// Added to a phone's home screen, the portal opens like an app: full
// screen, its own name and icon, the header's brown behind the status bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Earth Link Field Office",
    short_name: "Earth Link",
    description: "Earth Link General Construction portal",
    start_url: "/home",
    display: "standalone",
    background_color: "#F6F2EA",
    theme_color: "#2B231B",
    icons: [{ src: "/icon.png", sizes: "192x192", type: "image/png" }, { src: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  };
}
