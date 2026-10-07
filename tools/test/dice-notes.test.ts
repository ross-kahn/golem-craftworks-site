// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { planNotes } from "../dice-notes.ts";
import { descriptionHtml } from "../shared.ts";
import { DICE_SET_TEMPLATE, diceSetDescription, htmlToText } from "../../worker/src/descriptions.ts";

const APPLEBANE = "I swear I made up the name \"applebane\" because of the red and green in the dice. Still works!";
const full = (name: string, notes: string) => DICE_SET_TEMPLATE.replace("{NAME}", name).replace("{NOTES}", notes);
// The template's own lines, so the test follows whatever the wording is today.
const [title, subtitle, ...body] = DICE_SET_TEMPLATE.split("\n").filter((l) => l.trim() && !l.includes("{NOTES}"));
// An older wording of a template line: it opens the same way and ends differently.
const older = (line: string) => line.replace(/[.!]?$/, ", cheers!");

test("dice descriptions are cut down to what's particular to each set", () => {
  const plan = planNotes([
    { id: "A", name: '"APPLEBANE" TTRPG Dice Set', description: full("APPLEBANE", APPLEBANE) },
    // Pasted from APPLEBANE and never changed.
    { id: "B", name: '"MYSTIC" TTRPG Dice Set', description: full("MYSTIC", APPLEBANE) },
    // Older wording, an emoji in the title, and two notes of its own.
    { id: "C", name: '"JAVA" TTRPG Dice Set', description: [
      `☕️ ${title.replace("{NAME}", "JAVA")}\n${older(subtitle)}`,
      "Inspired by that perfect cup of coffee.",
      ...body.slice(0, -1).map(older),
      "Costs $55 & worth it.",
      older(body.at(-1)!)
    ].join("\n\n") },
    { id: "D", name: '"DEVA" TTRPG Dice Set', description: "Radiant." },
    { id: "E", name: "Heirloom Yahtzee Set", description: body.at(-1)! }
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
