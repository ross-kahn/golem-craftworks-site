// The description every dice set shares. Edit it here, then `npm run deploy`: every set follows.
//   {NAME}   the set's name, from the Square item name: `"JAVA" TTRPG Dice Set` -> JAVA
//   {NOTES}  whatever is typed in that item's description in Square (left out when there's nothing)

export const DICE_SET_TEMPLATE = `{NAME} 8-Piece Dice Set

Tabletop Gaming Dice for Dungeons & Dragons (D&D), Pathfinder, Call of Cthulhu, Shadowrun, and more

{NOTES}

This set comes with the full lineup:
D4, D6, D8, D10, D12, D20, D100 (percentile die), and a D2 coin.
The D2 can pull double duty as a status effect marker, an enemy token, or just a fun coin flip.

I make these by hand in my shop in Madison, WI. Every set is one of a kind. I design and print my own masters and pour my own silicone molds before creating the dice sets. After pouring the epoxy resin and curing it under pressure, I sand, polish, and paint each die by hand. No two sets ever come out exactly the same.

Perfect for your own TTRPG campaigns, or as a cool gift for someone who appreciates handmade dice.

Thanks for checking out my work!`;

// `"WILD MAGIC" TTRPG Dice Set` -> `WILD MAGIC`. Null for anything that isn't named like a dice set.
export const diceSetName = (itemName: string) =>
  itemName.trim().match(/^"(.+)" TTRPG Dice Set$/)?.[1] ?? null;

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const opening = (s: string) => words(s).split(" ").slice(0, 4).join(" ");

// A line of the template, or an older wording of one: it opens with the same four words. The title
// line is known by how it ends, since it opens with the set's name.
function isTemplateLine(line: string) {
  const w = words(line);
  if (!w) return false;
  return DICE_SET_TEMPLATE.split("\n").some((t) => {
    if (!words(t) || t.includes("{NOTES}")) return false;
    return t.includes("{NAME}")
      ? w.endsWith(words(t.replace("{NAME}", "")))
      : opening(line) === opening(t);
  });
}

// What a dice set's Square description says beyond the template: the set-specific part.
export function setNotes(description: string) {
  return description
    .split(/\r?\n/)
    .filter((line) => !isTemplateLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The full description for a dice set. Template lines still sitting in Square's text are dropped
// first, so a description that hasn't been trimmed down yet doesn't say everything twice.
export function diceSetDescription(name: string, squareText: string) {
  return DICE_SET_TEMPLATE.replace("{NAME}", () => name)
    .replace("{NOTES}", () => setNotes(squareText))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
