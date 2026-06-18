/** Comma-separated origins in CORS_ORIGIN; defaults to local Next.js dev. */
export function getAllowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (raw) {
    return raw.split(",").map((o) => o.trim()).filter(Boolean);
  }
  return ["http://localhost:3000", "http://127.0.0.1:3000"];
}
