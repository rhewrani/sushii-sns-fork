import { describe, expect, it } from "bun:test";
import { getFileExtFromURL } from "./http";

describe("getFileExtFromURL", () => {
  it("returns extension from a plain URL", () => {
    expect(getFileExtFromURL("https://example.com/image.jpg")).toBe("jpg");
  });

  it("ignores query params", () => {
    expect(getFileExtFromURL("https://example.com/image.png?param=1")).toBe(
      "png",
    );
  });

  it("returns mp4 from a complex CDN URL", () => {
    const url =
      "https://scontent-lhr8-1.cdninstagram.com/o1/v/t16/f2/m86/AQOYxXnje9MXjactoXrqtNo.mp4?stp=dst-mp4&efg=abc";
    expect(getFileExtFromURL(url)).toBe("mp4");
  });

  it("defaults to jpg when no extension", () => {
    expect(getFileExtFromURL("https://example.com/image")).toBe("jpg");
  });
});
