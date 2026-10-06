// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planNotes } from "../dice-notes.ts";
import { descriptionHtml } from "../shared.ts";
import { DICE_SET_TEMPLATE, diceSetDescription, htmlToText } from "../../worker/src/descriptions.ts";

const APPLEBANE = "I swear I made up the name \"applebane\" because of the red and green in the dice. Still works!";
const full = (name: string, notes: string) => DICE_SET_TEMPLATE.replace("{NAME}", name).replace("{NOTES}", notes);

test("dice descriptions are cut down to what's particular to each set", () => {
  const plan = planNotes([
    { id: "A", name: '"APPLEBANE" TTRPG Dice Set', description: full("APPLEBANE", APPLEBANE) },
    // Pasted from APPLEBANE and never changed.
    { id: "B", name: '"MYSTIC" TTRPG Dice Set', description: full("MYSTIC", APPLEBANE) },
    // Older wording, an emoji in the title, the lineup on one line, and two notes of its own.
    { id: "C", name: '"JAVA" TTRPG Dice Set', description: [
      "☕️ JAVA 8-Piece Dice Set\nTabletop Gaming Dice for Dungeons & Dragons (D&D), Pathfinder, and more",
      "Inspired by that perfect cup of coffee.",
      "This set comes with the full lineup: D4, D6, D8, D10, D12, D20, D100 (percentile die), and a D2 coin. The D2 can pull double duty as a coin flip.",
      "I make these by hand in my shop in Madison, WI. Every set is one-of-a-kind.",
      "Costs $55 & worth it.",
      "Perfect for your in-person or online campaigns.",
      "Thanks for checking out my work, cheers!"
    ].join("\n\n") },
    { id: "D", name: '"DEVA" TTRPG Dice Set', description: "Radiant." },
    { id: "E", name: "Heirloom Yahtzee Set", description: "Thanks for checking out my work!" }
  ]);

  assert.deepEqual(plan.map((s) => [s.name, s.notes, s.changed]), [
    ["APPLEBANE", APPLEBANE, true],
    ["MYSTIC", "", true],
    ["JAVA", "Inspired by that perfect cup of coffee.\n\nCosts $55 & worth it.", true],
    ["DEVA", "Radiant.", false]
  ]);
  assert.deepEqual(plan[1].copied, [APPLEBANE]);

  // What goes to Square comes back as the same notes, and the site builds the same page from either.
  const java = plan[2].notes;
  assert.equal(htmlToText(descriptionHtml(java)), java);
  assert.equal(diceSetDescription("JAVA", java), full("JAVA", java));
  assert.equal(diceSetDescription("MYSTIC", ""), full("MYSTIC", "").replace("\n\n\n\n", "\n\n"));
});
