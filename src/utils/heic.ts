import sharp from "sharp";
import logger from "../logger";
import type { File } from "../platforms/base";

const log = logger.child({ module: "heicConverter" });

export async function convertHeicToJpeg(files: File[]): Promise<File[]> {
  const convertedFiles = files.map(async (file, idx) => {
    if (file.ext !== "heic") {
      return file;
    }

    try {
      const jpgBuffer = await sharp(file.buffer).jpeg().toBuffer();
      file.buffer = jpgBuffer;
      file.ext = "jpg";
      log.debug("Converted HEIC to JPG", { index: idx });

      return file;
    } catch (err) {
      log.error("Failed to convert HEIC to JPG", {
        index: idx,
        error: err,
      });

      // Re-throw, will be caught by the caller
      throw err;
    }
  });

  return Promise.all(convertedFiles);
}
