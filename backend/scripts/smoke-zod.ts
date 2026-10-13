/** Throwaway probe for the Zod 4 / zod-to-openapi primitives the contract uses. */
import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

const reg = new OpenAPIRegistry();

const checks: Array<[string, () => unknown]> = [
  ["z.uuid()", () => z.uuid().parse("01890f4a-0000-7000-8000-000000000000")],
  ["z.iso.datetime()", () => z.iso.datetime().parse("2026-11-01T02:00:00Z")],
  ["z.iso.date()", () => z.iso.date().parse("2026-11-01")],
  ["z.strictObject rejects unknown", () => {
    const s = z.strictObject({ a: z.string() });
    const r = s.safeParse({ a: "x", b: 1 });
    if (r.success) throw new Error("unknown key accepted");
    return "rejected";
  }],
  ["z.enum", () => z.enum(["owner", "coach"]).parse("owner")],
  ["z.record(k,v)", () => z.record(z.string(), z.unknown()).parse({ a: 1 })],
  ["z.coerce.number().int()", () => z.coerce.number().int().parse("25")],
  ["z.discriminatedUnion", () => z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), a: z.string() }),
    z.object({ kind: z.literal("b"), b: z.number() }),
  ]).parse({ kind: "b", b: 2 })],
  ["refine", () => z.string().refine((v) => v.length > 1, "too short").parse("ab")],
  ["int().nonnegative()", () => z.number().int().nonnegative().parse(0)],
  ["default on optional", () => z.object({ p: z.number().int().default(1) }).parse({})],
];

for (const [name, fn] of checks) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Component registration + $ref rendering + 3.1 document generation + extensions.
const Meta = reg.register("Meta", z.object({ page: z.number().int(), pageSize: z.number().int() }));
reg.registerPath({
  method: "get",
  path: "/things",
  operationId: "THG-01",
  summary: "probe",
  tags: ["probe"],
  request: { query: z.object({ page: z.coerce.number().int().optional() }) },
  responses: {
    200: {
      description: "ok",
      content: { "application/json": { schema: z.object({ data: z.array(z.string()), meta: Meta }) } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
    },
  },
  "x-ia-milestone": "m2",
} as never);

const doc = new OpenApiGeneratorV31(reg.definitions).generateDocument({
  openapi: "3.1.0",
  info: { title: "probe", version: "0" },
});

console.log("--- generated ---");
console.log(JSON.stringify(doc, null, 1).slice(0, 1200));
