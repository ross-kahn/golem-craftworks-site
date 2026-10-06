// Works out what each dice set's Square description should be cut down to: only what's particular
// to that set. The shared wording now comes from the template in worker/src/descriptions.ts.
// No network here, so it can be tested; clear-dice-descriptions.ts does the reading and writing.
import { diceSetName, setNotes } from "../worker/src/descriptions.ts";
import { norm } from "./shared.ts";

export interface SetNotes {
  id: string;
  name: string; // the set name: JAVA
  notes: string; // what stays in Square
  copied: string[]; // lines dropped because they belong to another set
  changed: boolean;
}

export function planNotes(items: { id: string; name: string; description: string }[]): SetNotes[] {
  const sets = items.flatMap((item) => {
    const name = diceSetName(item.name);
    return name ? [{ id: item.id, name, description: item.description.trim(), lines: setNotes(item.description).split("\n") }] : [];
  });
  const uses = new Map<string, number>();
  for (const s of sets) for (const line of new Set(s.lines.map(norm))) if (line) uses.set(line, (uses.get(line) || 0) + 1);

  return sets.map((s) => {
    // A line on several sets was pasted along from one of them. It stays only on the set it names.
    const copied = s.lines.filter((line) => (uses.get(norm(line)) || 0) > 1 && !norm(line).includes(norm(s.name)));
    const notes = s.lines.filter((line) => !copied.includes(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { id: s.id, name: s.name, notes, copied, changed: notes !== s.description };
  });
}
