import { describe, expect, it } from "bun:test";
import { enqueuePost } from "./queue";

describe("enqueuePost", () => {
  it("runs execute and resolves when it succeeds", async () => {
    let ran = false;
    await enqueuePost(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("processes jobs in FIFO order (one at a time)", async () => {
    const order: number[] = [];
    const p1 = enqueuePost(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 15));
    });
    const p2 = enqueuePost(async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("rejects when execute throws", async () => {
    await expect(
      enqueuePost(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
