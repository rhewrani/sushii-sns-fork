import { describe, expect, it, test } from "bun:test";
import { type Platform } from "../platforms/base";
import { chunkArray, formatDiscordTitle, itemsToMessageContents } from "./discord";

describe("chunkArray", () => {
  test("should split array into chunks of specified size", () => {
    const arr = [1, 2, 3, 4, 5];
    const chunkSize = 2;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("should handle empty array", () => {
    const arr: number[] = [];
    const chunkSize = 2;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([]);
  });

  test("should handle chunk size larger than array length", () => {
    const arr = [1, 2, 3];
    const chunkSize = 5;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1, 2, 3]]);
  });

  test("should handle chunk size of 1", () => {
    const arr = [1, 2, 3];
    const chunkSize = 1;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1], [2], [3]]);
  });

  test("should handle chunk size equal to array length", () => {
    const arr = [1, 2, 3];
    const chunkSize = 3;
    const result = chunkArray(arr, chunkSize);
    expect(result).toEqual([[1, 2, 3]]);
  });
});

describe("formatDiscordTitle", () => {
  it("should format title with date", () => {
    const platform: Platform = "twitter";
    const username = "testuser";
    const date = new Date("2023-10-01");
    const title = formatDiscordTitle(platform, username, date);
    expect(title).toBe("`231001 testuser Twitter Update`");
  });

  it("should format title with date in KST timezone", () => {
    const platform: Platform = "twitter";
    const username = "testuser";
    // UTC timezone 4pm
    const date = new Date("2023-10-01T16:00:00Z");
    const title = formatDiscordTitle(platform, username, date);

    // Next day vs UTC
    expect(title).toBe("`231002 testuser Twitter Update`");
  });

  it("should format title without date", () => {
    const platform: Platform = "instagram";
    const username = "testuser";
    const title = formatDiscordTitle(platform, username);
    expect(title).toBe("`testuser Instagram Update`");
  });

  it("should capitalize platform name", () => {
    const platform: Platform = "twitter";
    const username = "testuser";
    const title = formatDiscordTitle(platform, username);
    expect(title).toBe("`testuser Twitter Update`");
  });

  it("should handle empty username", () => {
    const platform: Platform = "instagram";
    const username = "";
    const title = formatDiscordTitle(platform, username);
    expect(title).toBe("` Instagram Update`");
  });

  it("should handle undefined date", () => {
    const platform: Platform = "twitter";
    const username = "testuser";
    const title = formatDiscordTitle(platform, username, undefined);
    expect(title).toBe("`testuser Twitter Update`");
  });
});

describe("itemsToMessageContents", () => {
  test("returns single message when items fit", () => {
    const result = itemsToMessageContents("header\n", ["url1", "url2"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("header\nurl1\nurl2\n");
  });

  test("splits into multiple messages when exceeding 2000 chars", () => {
    const longUrl = "https://example.com/" + "a".repeat(1000);
    const result = itemsToMessageContents("", [longUrl, longUrl, longUrl]);
    expect(result.length).toBeGreaterThan(1);
  });

  test("header only appears in first chunk", () => {
    const longUrl = "https://example.com/" + "a".repeat(1000);
    const result = itemsToMessageContents("header\n", [longUrl, longUrl, longUrl]);
    expect(result[0]).toContain("header");
    expect(result[1]).not.toContain("header");
  });

  test("returns empty array for no items and empty initial message", () => {
    const result = itemsToMessageContents("", []);
    expect(result).toHaveLength(0);
  });

  test("returns initial message when no items", () => {
    const result = itemsToMessageContents("header\n", []);
    expect(result).toEqual(["header\n"]);
  });
});
