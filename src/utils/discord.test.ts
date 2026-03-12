import { describe, expect, it, test } from "bun:test";
import { type Platform } from "../platforms/base";
import { chunkArray, formatDiscordTitle } from "./discord";

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
