// Sri Lankan phone normalisation (E.164). Used by the register form and by the
// CSV import preview so a number is judged by exactly one rule in both places.
// The server remains the authority (API_CONTRACTS §3.4: "phone normalized to
// E.164 (LK default)"); this only previews what will be sent.

/** "077 000 0001" → "+94770000001"; null when it cannot be a valid LK number. */
export function normalizeLkPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/[^\d]/g, "");
  if (/^0\d{9}$/.test(digits)) return `+94${digits.slice(1)}`; // 0770000001
  if (/^94\d{9}$/.test(digits)) return `+${digits}`; // 94770000001
  if (/^\d{9}$/.test(digits)) return `+94${digits}`; // 770000001
  if (/^\+94\d{9}$/.test(raw.trim())) return raw.trim();
  return null;
}

/** Display form for a stored E.164 number: "+94 77 000 0001". */
export function formatLkPhone(e164: string): string {
  const match = /^\+94(\d{2})(\d{3})(\d{4})$/.exec(e164);
  if (!match) return e164;
  return `+94 ${match[1]} ${match[2]} ${match[3]}`;
}
