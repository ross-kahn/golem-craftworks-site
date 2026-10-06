// Shared by the Etsy import tools: reading Etsy's CSV export and calling Square.

// Minimal RFC 4180 CSV parser (handles quotes, commas and newlines inside fields).
// Rows come back keyed by the upper-cased column heading.
export function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const keys = head.map((h) => h.replace(/^﻿/, "").trim().toUpperCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || "").trim()])));
}

// Lower-case letters and digits only, for comparing titles.
export const norm = (s: string | undefined) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function squareClient({ token, sandbox = false, version = process.env.SQUARE_VERSION || "2025-01-23" }: { token: string; sandbox?: boolean; version?: string }) {
  const base = sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  return async function sq<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "square-version": version, ...(init.headers || {}) }
    });
    const data = (await res.json().catch(() => ({}))) as T & { errors?: unknown };
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data.errors || data)}`);
    return data;
  };
}

export type SquareCall = ReturnType<typeof squareClient>;

export const postJSON = (body: unknown): RequestInit =>
  ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Plain text to the formatted description Square stores: a paragraph per blank line, breaks within them.
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
export const descriptionHtml = (text: string) =>
  text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, "<br>")}</p>`).join("");
