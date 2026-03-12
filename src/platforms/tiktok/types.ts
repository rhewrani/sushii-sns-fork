import * as z from "zod";

export const AuthorSchema = z.object({
  unique_id: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const DownloadAddrSchema = z.object({
  url_list: z.array(z.string()).optional(),
});
export type DownloadAddr = z.infer<typeof DownloadAddrSchema>;

export const VideoSchema = z.object({
  play_addr: DownloadAddrSchema.optional(),
});
export type Video = z.infer<typeof VideoSchema>;

export const AwemeDetailSchema = z.object({
  author: AuthorSchema.optional(),
  video: VideoSchema.optional(),
  create_time: z.number().optional(),
});
export type AwemeDetail = z.infer<typeof AwemeDetailSchema>;

export const DataSchema = z.object({
  aweme_detail: AwemeDetailSchema.optional(),
  status_code: z.number().optional(),
});
export type Data = z.infer<typeof DataSchema>;

export const TikTokPostResponseSchema = z.object({
  status: z.string().optional(),
  data: DataSchema.optional(),
});
export type TikTokPostResponse = z.infer<typeof TikTokPostResponseSchema>;
