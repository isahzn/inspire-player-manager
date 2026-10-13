/** Throwaway probe: which otplib v13 entry points do we actually need? */
import * as otplib from "otplib";

console.log("exports:", Object.keys(otplib).sort().join(", "));

const fns = otplib as unknown as Record<string, (...args: unknown[]) => unknown>;

try {
  const secret = fns["generateSecret"]?.();
  console.log("generateSecret:", secret);

  const uri = fns["generateURI"]?.({
    secret,
    label: "owner@inspire",
    issuer: "Inspire Academy",
  });
  console.log("generateURI:", uri);

  const code = fns["generate"]?.({ secret });
  console.log("generate:", code);

  const ok = fns["verify"]?.({ secret, token: String(code) });
  console.log("verify(correct):", ok);
  const bad = fns["verify"]?.({ secret, token: "000000" });
  console.log("verify(wrong):", bad);
} catch (err) {
  console.log("probe failed:", err instanceof Error ? err.message : err);
}
