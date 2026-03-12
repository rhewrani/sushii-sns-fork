import { describe, expect, it } from "bun:test";
import { type Platform } from "../base";

import { formatDiscordTitle } from "../../utils/discord";
import { getFileExtFromURL } from "../../utils/http";

import { InstagramPostDownloader } from "../instagram-post/downloader";

describe("twitter", () => {
  describe("waitUntilDataReady", async () => {
    const dl = new InstagramPostDownloader();

    await dl.waitUntilDataReady("s_m4g93skg2rg9yz1ewi");
  });

  describe("fetchSnapshotData", async () => {
    const dl = new InstagramPostDownloader();

    const data = await dl.fetchSnapshotData("s_m4g93skg2rg9yz1ewi");
    expect(data).toBeDefined();
    expect(data.user_posted).toBe("vampirehollie");
  });

  describe("getFileExtFromURL", () => {
    it("should return the correct file extension from a URL", () => {
      const url =
        "https://scontent-lhr8-1.cdninstagram.com/o1/v/t16/f2/m86/AQOYxXnje9MXjactoXrqtNo-5ZzRweEZL2ndQRhN2ihL5UcXnuX5gnp8VNCC_ECSNe5YUouQNumHZCTbae_82_B1C8ldGtfL9NCszJg.mp4?stp=dst-mp4&efg=eyJxZV9ncm91cHMiOiJbXCJpZ193ZWJfZGVsaXZlcnlfdnRzX290ZlwiXSIsInZlbmNvZGVfdGFnIjoidnRzX3ZvZF91cmxnZW4uY2xpcHMuYzIuNzIwLmJhc2VsaW5lIn0&_nc_cat=108&vs=1257991175450831_4046028505&_nc_vs=HBksFQIYUmlnX3hwdl9yZWVsc19wZXJtYW5lbnRfc3JfcHJvZC8wNjQyNkIyMDkxQjIyMTRGRTExQUFGMUVENzBFOTM5QV92aWRlb19kYXNoaW5pdC5tcDQVAALIAQAVAhg6cGFzc3Rocm91Z2hfZXZlcnN0b3JlL0dDZDEteHUwa01jM3p3c0NBTlEySkdPYVhzb1ZicV9FQUFBRhUCAsgBACgAGAAbABUAACaahd6Ao%2FuJQBUCKAJDMywXQDwqfvnbItEYEmRhc2hfYmFzZWxpbmVfMV92MREAdf4HAA%3D%3D&_nc_rid=ead5f10303&ccb=9-4&oh=00_AYDVA0i5rPwz_Csi5t1WcTpMwX4RpWPVGtxw9P2tDmUpGg&oe=6757FB4F&_nc_sid=4f4799";
      const ext = getFileExtFromURL(url);
      expect(ext).toBe("mp4");
    });

    it("should ignore params from a URL", () => {
      const url = "https://example.com/image.png?param=1";
      const ext = getFileExtFromURL(url);
      expect(ext).toBe("png");
    });

    it("should return 'jpg' if no extension is found", () => {
      const url = "https://example.com/image";
      const ext = getFileExtFromURL(url);
      expect(ext).toBe("jpg");
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
  });
});
