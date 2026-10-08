// Text helpers shared by the Worker, the site and the tools.
import { sift } from "radashi";

// "Dice, Wood ,," -> ["Dice", "Wood"]: a comma-separated setting, or a cell of Etsy's export, as a list.
export const csvList = (s?: string) =>
  sift((s || "").split(",").map((x) => x.trim()));

export const withoutSlash = (s: string) => s.replace(/\/$/, "");

// Makes text safe to put into a page.
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Lower-case letters and digits only, for comparing wording.
export const words = (s?: string) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// `"JAVA" TTRPG Dice Set` -> `java-ttrpg-dice-set`
// Product and category addresses are built from this, so changing it breaks links.
export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ'’"]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// "can&#39;t" -> "can't". Text from Etsy and Square arrives with characters written as HTML codes.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};
export const decodeEntities = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) =>
    dec
      ? String.fromCodePoint(Number(dec))
      : hex
        ? String.fromCodePoint(parseInt(hex, 16))
        : (NAMED_ENTITIES[name.toLowerCase()] ?? m),
  );

// Formatted text to plain text, keeping the shape: a blank line between paragraphs, single breaks within them.
export function htmlToText(html?: string) {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/\s*\n\s*/g, " ")
      .replace(/<\/(p|div|ul|ol|h\d)>/gi, "\n\n")
      .replace(/<(br\s*\/?|\/li)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
