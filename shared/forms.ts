// The site's two forms, described once. The page checks what was typed against these before sending,
// and the Worker checks again on arrival, so both say the same thing about the same mistake.
// The words on each rule are how the error message names what's missing.
import * as v from "valibot";
import { emailAddress, line, paragraph } from "./validate.ts";

// ---------- Commission request ----------

export const COMMISSION_TYPES = [
  "Dice vault",
  "Game set or box",
  "Dice",
  "Engraving on an existing design",
  "Something else",
] as const;

export const Commission = v.object({
  name: v.pipe(line(100), v.nonEmpty("your name")),
  email: emailAddress,
  type: v.fallback(v.picklist(COMMISSION_TYPES), "Something else"),
  idea: v.pipe(paragraph(4000), v.nonEmpty("a description of your idea")),
  when: line(200),
  budget: line(200),
});
export type CommissionData = v.InferOutput<typeof Commission>;

// ---------- Review ----------

export const REVIEW_MAX_PHOTOS = 3;

export const Review = v.object({
  name: v.pipe(
    paragraph(60),
    v.transform((s) => s.replace(/\s+/g, " ")),
    v.nonEmpty("your name"),
  ),
  email: emailAddress,
  rating: v.pipe(
    line(8),
    v.regex(/^[1-5]$/, "a star rating"),
    v.transform(Number),
  ),
  text: v.pipe(paragraph(2000), v.nonEmpty("a few words about it")),
  product: paragraph(120),
  // The spam checks: a field that should stay empty, how long the form was open, and Turnstile's answer.
  website: paragraph(10),
  elapsed: v.pipe(paragraph(12), v.transform(Number)),
  "cf-turnstile-response": paragraph(4000),
});
export type ReviewData = v.InferOutput<typeof Review>;
