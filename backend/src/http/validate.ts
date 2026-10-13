/**
 * Validation at the edge (SECURITY_AND_PRIVACY §3.3, BACKEND_BUILD_GUIDE §3).
 *
 * Request bodies are `z.strictObject`, so an unknown field is a 422 rather than a
 * silently ignored key (T-SEC-02, mass assignment). Every issue is mapped to the
 * contract's `details[]` with the field path, which is what the frontend binds inline
 * form errors to.
 */
import { z } from "zod";
import { errors, type ErrorDetail } from "../errors.js";

function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    ...(issue.path.length ? { field: issue.path.map(String).join(".") } : {}),
    issue: issue.message,
  }));
}

/** Parses input and throws `422 VALIDATION_ERROR` with per-field details on failure. */
export function parse<T extends z.ZodType>(schema: T, input: unknown, what = "request"): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = toDetails(result.error);
  throw errors.validation(
    details.length ? details : [{ field: what, issue: "Invalid value." }],
  );
}

/**
 * Sorts: `?sort=-dueDate,fullName`. Only allow-listed fields are accepted and an
 * unknown one is 422 `INVALID_SORT` — never a 500 and never interpolated into SQL
 * (T-SEC-03).
 */
export interface SortSpec {
  column: string;
  direction: "asc" | "desc";
}

export function parseSort(raw: string | undefined, allowed: readonly string[], fallback?: string): SortSpec[] {
  const source = raw?.trim() || fallback || "";
  if (!source) return [];
  const specs: SortSpec[] = [];
  for (const token of source.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const direction = trimmed.startsWith("-") ? "desc" : "asc";
    const field = trimmed.replace(/^-/, "");
    // Map the API's camelCase field to a snake_case column.
    const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!allowed.includes(field)) {
      throw errors.validation([{ field: "sort", issue: `Unknown sort field "${field}".` }]);
    }
    specs.push({ column, direction });
  }
  return specs;
}

/** Renders a validated sort spec into SQL-safe `ORDER BY` text (identifiers only). */
export function orderByClause(specs: SortSpec[], tiebreak = "id"): string {
  const parts = specs.map((s) => `${s.column} ${s.direction === "desc" ? "desc" : "asc"}`);
  // Stable tiebreak by id, so paging cannot repeat or skip rows (API_CONTRACTS §1).
  parts.push(`${tiebreak} asc`);
  return `order by ${parts.join(", ")}`;
}
