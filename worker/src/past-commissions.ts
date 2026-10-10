// Past commissions shown on the commissions page, in the order they appear there. Each has its own
// page at /commissions/<slug>. Edit them here, then `npm run deploy`.
//
// Photos aren't listed here. Drop them in commission-photos/<slug>/ and `npm run build` sizes them for
// the site, thumbnails included; they show in file-name order, the first four on the commissions page
// (see the README).

import type { COMMISSION_TYPES } from "../../shared/forms.ts";

export interface Piece {
  slug: string; // its address and its photo folder. Changing it breaks links to the page.
  name: string;
  // What the commission form calls this kind of piece. "Start a commission like this" picks it on the form.
  type: (typeof COMMISSION_TYPES)[number];
  summary: string; // one line: under the name on the commissions page, and what search results show
  story: string; // the write-up on its own page. Leave a blank line between paragraphs.
}

const dragon_hex = `A client had a set of stone dice from Misty Mountain Gaming that was very special to them. They wanted a nice wooden vault to keep them safe and display them at the table, but they were oversized and didn't fit easily into existing vaults. I borrowed the dice from them, took measurements, and designed this hex vault from local walnut which fits each die perfectly snug. I was able to engrave the celtic-style dragon on the front which the client sent to me. If you have some existing dice and want a special place to keep them, send me a message!`;

const balrog_one_ring = `A client had a family member who was really into both Lord of the Rings and tabletop games, but the client themselves didn't know too much about either. They asked if I could help provide some vision for a couple of sets in this theme, and I came up with a flame-and-smoke Balrog set and a gold-and-black One Ring set. I sent the client lots of pictures early on in the process to see if they liked it before moving on. If you want something special but aren't sure exactly what, let me know and we can brainstorm together!`;

const black_templar = `A client who played Warhammer 40k as the Black Templar space marines asked me to make a combination of numerical and pipped d6s to go with their army. If you have an inspiration photo you'd like to use for a commission, I can absolutely try and complement it!`;

const tyranid_necron = `A client loved playing Warhammer 40k and painting his own minis. They wanted dice to match the color scheme of their army. I actually went through a few different iterations on these pink and purple d6s for them, which I'm happy to do until I get something you like! They decided they also wanted to commission a set for a friend who played Necrons with a black-and-green theme, which I was happy to work on and send at the same time.`;

export const PIECES: Piece[] = [
  {
    slug: "dragon-hex-box",
    name: "Celtic Dragon Hex Vault",
    type: "Dice vault",
    summary:
      "Walnut hex dice vault, custom fit for a client's existing dice set",
    story: dragon_hex,
  },
  {
    slug: "balrog-one-ring",
    name: "Balrog + The One Ring Dice Sets",
    type: "Dice",
    summary: "Dice commission for a LotR fan.",
    story: balrog_one_ring,
  },
  {
    slug: "black-templars-40k",
    name: "Black Templars 40k Set",
    type: "Dice",
    summary: "Themed Warhammer 40k dice set with both numeral and pip dice.",
    story: black_templar,
  },
  {
    slug: "tyranids-necrons-40k",
    name: "Tyranid + Necron 40k Sets",
    type: "Dice",
    summary: "Themed Warhammer 40k dice sets.",
    story: tyranid_necron,
  },
];
