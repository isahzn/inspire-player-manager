/**
 * Message templates — the `{{variable}}` substitution every outgoing message goes through
 * (OPENWA_INTEGRATION §5, DATABASE §3.6).
 *
 * The templates are the owner's own words, stored in `message_templates` and edited through
 * settings; this file is only the filling-in and the checking. Two properties matter more than
 * the substitution itself:
 *
 *  1. **A placeholder is never silently emptied.** If a message needs `{{amountDue}}` and the
 *     caller did not supply it, the text keeps the literal `{{amountDue}}` and the gap is
 *     reported. A guardian receiving "Amount due: " is worse than a message that fails to send,
 *     because nobody notices the first one.
 *  2. **A typo is not a variable.** `{{amounDue}}` is reported as *unknown* rather than left in
 *     the message, which is what lets a settings screen refuse a template at save time instead
 *     of discovering it at send time.
 *
 * Nothing here knows about a provider, a queue or a phone number: it turns a body and some
 * values into text, and says what is wrong when it cannot.
 */

/** The variables each template key may use (OPENWA_INTEGRATION §5). */
export const TEMPLATE_VARIABLES = [
  "guardianName",
  "playerName",
  "invoiceNumber",
  "amountDue",
  "dueDate",
  "invoiceLink",
  "academyName",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type TemplateValues = Partial<Record<TemplateVariable, string>>;

/** `{{ name }}` — whitespace tolerated, because a human types these. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface TemplateFill {
  /** The body with every supplied variable substituted. */
  text: string;
  /** Variables the body uses that were not supplied, in the order they appear. */
  missing: TemplateVariable[];
  /** Placeholders in the body that are not variables of this system. */
  unknown: string[];
  /** Every variable the body actually uses — what a settings screen would report on save. */
  used: string[];
}

/**
 * Fills a template body.
 *
 * `known` defaults to the system's variable list; it is a parameter so a future template with its
 * own vocabulary does not have to edit this function.
 */
export function fillTemplate(
  body: string,
  values: TemplateValues,
  known: readonly string[] = TEMPLATE_VARIABLES,
): TemplateFill {
  const missing: string[] = [];
  const unknown: string[] = [];
  const used: string[] = [];

  const text = body.replace(PLACEHOLDER, (whole, name: string) => {
    if (!used.includes(name)) used.push(name);
    if (!known.includes(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      return whole;
    }
    const value = values[name as TemplateVariable];
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return value;
  });

  return {
    text,
    missing: missing as TemplateVariable[],
    unknown,
    used,
  };
}

/**
 * The variables a body uses, and any it uses that do not exist.
 *
 * This is the "validated on save" half of the rule, kept next to the fill so a template cannot be
 * accepted by the settings screen and then fail to fill at send time.
 */
export function inspectTemplate(body: string, known: readonly string[] = TEMPLATE_VARIABLES): {
  used: string[];
  unknown: string[];
} {
  const used: string[] = [];
  const unknown: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!used.includes(name)) used.push(name);
    if (!known.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return { used, unknown };
}

/**
 * A `wa.me` link that opens WhatsApp with the message ready to send (`OPEN-025`'s owner-side
 * action: the same text, sent by a person instead of an automation).
 *
 * `wa.me` takes the number without a `+`, so an E.164 number is stripped of punctuation. This is
 * a convenience for the operator, not a messaging path: nothing here contacts WhatsApp.
 */
export function whatsappDeepLink(phoneE164: string | null, text: string): string | null {
  const digits = (phoneE164 ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
