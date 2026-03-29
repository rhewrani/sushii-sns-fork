import { afterEach, describe, expect, it } from "bun:test";
import { fetchWithHeaders, getFileExtFromURL } from "./http";

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

describe("fetchWithHeaders", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sets User-Agent when given a URL string", async () => {
    let lastInit: RequestInit | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    await fetchWithHeaders("https://example.com/path");
    expect(new Headers(lastInit?.headers).get("User-Agent")).toContain("sushii-sns");
  });

  it("preserves existing init headers and adds User-Agent", async () => {
    let lastInit: RequestInit | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    await fetchWithHeaders("https://example.com/", {
      headers: { "X-Test": "1" },
    });
    const h = new Headers(lastInit?.headers);
    expect(h.get("User-Agent")).toContain("sushii-sns");
    expect(h.get("X-Test")).toBe("1");
  });

  it("merges User-Agent into an existing Request", async () => {
    let lastRequest: Request | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      lastRequest = input instanceof Request ? new Request(input, init) : new Request(input, init);
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer token" },
    });
    await fetchWithHeaders(req);
    expect(lastRequest?.headers.get("User-Agent")).toContain("sushii-sns");
    expect(lastRequest?.headers.get("Authorization")).toBe("Bearer token");
  });
});
