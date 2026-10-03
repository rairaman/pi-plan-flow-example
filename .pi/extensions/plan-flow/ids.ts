// Plan ids and folder names. A plan is identified by a short random id; the slug is only a label.
import { randomInt } from "node:crypto";

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 4;
const SLUG_WORDS = 4;
const SLUG_MAX = 32;
const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "and", "or", "in", "on", "at", "by", "with", "from", "into", "onto",
  "add", "adds", "adding", "make", "build", "create", "implement", "support", "new", "some", "our", "my", "so", "that", "it",
]);

export const ID_PATTERN = /^[0-9a-z]{4}$/;

// Random base36 id; `taken` lets the caller re-roll on a clash with an existing plan.
export function newId(taken: (id: string) => boolean = () => false): string {
  for (let i = 0; i < 100; i++) {
    let id = "";
    for (let j = 0; j < ID_LENGTH; j++) id += ID_CHARS[randomInt(ID_CHARS.length)];
    if (!taken(id)) return id;
  }
  throw new Error("Could not find a free plan id after 100 tries");
}

// "Add scheduled emails to contacts" -> "scheduled-emails-contacts"
export function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  let slug = "";
  for (const w of (meaningful.length ? meaningful : words).slice(0, SLUG_WORDS)) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug || "plan";
}

export function planDirName(id: string, slug: string): string {
  return `${id}-${slug}`;
}

// Accepts "k3f9", "k3f9-some-slug" or ".plan/k3f9-some-slug/"; returns the id or undefined.
export function idFromArg(arg: string): string | undefined {
  const m = arg.trim().replace(/^\.plan\//, "").replace(/\/+$/, "").match(/^([0-9a-z]{4})(?:-|$)/);
  return m?.[1];
}

export function branchFor(dirName: string): string {
  return `factory/${dirName}`;
}
