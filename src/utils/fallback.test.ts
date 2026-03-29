import { describe, expect, it } from "bun:test";
import { tryWithFallbacks } from "./fallback";

describe("tryWithFallbacks", () => {
  it("returns the first successful result", async () => {
    const result = await tryWithFallbacks([
      { name: "a", fn: async () => "ok" },
      { name: "b", fn: async () => "should-not-run" },
    ]);
    expect(result).toBe("ok");
  });

  it("uses the next provider when the first throws", async () => {
    const result = await tryWithFallbacks([
      { name: "fail", fn: async () => { throw new Error("first"); } },
      { name: "ok", fn: async () => 42 },
    ]);
    expect(result).toBe(42);
  });

  it("throws AggregateError when every provider fails", async () => {
    try {
      await tryWithFallbacks([
        { name: "a", fn: async () => { throw new Error("a"); } },
        { name: "b", fn: async () => { throw new Error("b"); } },
      ]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      const agg = e as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect((agg.errors[0] as Error).message).toBe("a");
      expect((agg.errors[1] as Error).message).toBe("b");
    }
  });

  it("wraps non-Error throws as Error in AggregateError", async () => {
    try {
      await tryWithFallbacks([
        { name: "x", fn: async () => { throw "string-throw"; } },
      ]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AggregateError);
      const agg = e as AggregateError;
      expect((agg.errors[0] as Error).message).toBe("string-throw");
    }
  });
});
