// Checking what a visitor typed into a form, with Valibot (https://valibot.dev).
// A form's fields are described once as a schema; `check` cleans them up and says what's missing.
import * as v from "valibot";
import { unique } from "radashi";

// A field as text, tidied by `clean`. One that's absent, or isn't text, counts as empty.
const text = (clean: (s: string) => string) =>
  v.pipe(
    v.optional(v.unknown(), ""),
    v.transform((x) => (typeof x === "string" ? clean(x) : "")),
  );

// A field that may run over several lines, trimmed and cut to `max` characters.
export const paragraph = (max: number) => text((s) => s.trim().slice(0, max));

// A one-line field: line breaks become spaces, so nothing typed can start a new line in an email's headers.
export const line = (max: number) =>
  text((s) =>
    s
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, max),
  );

// One @, no spaces, a dotted domain with a 2+ letter ending.
export const emailAddress = v.pipe(line(254), v.email("a valid email"));
export const isEmail = (s: unknown) => v.is(emailAddress, s);

/**
 * Run what a form holds through its schema.
 *   data     the cleaned-up fields
 *   missing  each field that didn't pass, in the words given to its rule ("your name"), ready for an error message
 *   fields   the names of those fields, for marking them on the page
 */
export function check<S extends v.GenericSchema>(schema: S, input: unknown) {
  const result = v.safeParse(
    schema,
    input && typeof input === "object" ? input : {},
  );
  const issues = result.issues || [];
  return {
    data: result.output as v.InferOutput<S>,
    missing: unique(issues.map((i) => i.message)),
    fields: unique(issues.map((i) => String(i.path?.[0]?.key ?? ""))),
  };
}
