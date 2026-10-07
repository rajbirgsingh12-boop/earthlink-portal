// Smooth scrolling through one door, so a person who turned motion off on
// their phone gets a plain jump instead of a glide.
export const scrollTo = (el: Element | null, block: ScrollLogicalPosition = "center") =>
  el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block });
