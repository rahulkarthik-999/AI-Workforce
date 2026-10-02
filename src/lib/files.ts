/** File naming for downloads. Pure, so it is shared by routes and tests. */

export function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "md";
}

/** A filesystem-safe name derived from a document title (no path separators, no control chars). */
export function safeFileName(title: string, ext: string, fallback = "document"): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || fallback;
  return `${base}.${ext}`;
}

/** Makes every name in a list unique by suffixing -2, -3 ... before the extension. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
  });
}
