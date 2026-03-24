import z from "zod";

// Brightdata API types
export const BdTriggerResponseSchema = z.object({
  snapshot_id: z.string().optional(),
});

export type BdTriggerResponse = z.infer<typeof BdTriggerResponseSchema>;

export const BdMonitorStatus = z.enum(["starting", "running", "ready", "failed"]);

export const BdMonitorResponseSchema = z.object({
  status: BdMonitorStatus,
  snapshot_id: z.string().optional(),
  // dataset_id: z.string().optional(),
  // records: z.number().optional(),
  errors: z.any().optional(),
  // collection_duration: z.number().optional(),
});
export type BdMonitorResponse = z.infer<typeof BdMonitorResponseSchema>;

// Instagram post types
// Generated from quicktype https://app.quicktype.io/?l=ts

export const TypeSchema = z.enum(["Photo", "Video"]);
export type Type = z.infer<typeof TypeSchema>;

export const AudioSchema = z.object({
  audio_asset_id: z.string().optional().nullable(),
  original_audio_title: z.string().optional().nullable(),
  ig_artist_username: z.string().optional().nullable(),
  ig_artist_id: z.string().optional().nullable(),
});
export type Audio = z.infer<typeof AudioSchema>;

export const InputSchema = z.object({
  url: z.string().optional(),
});
export type Input = z.infer<typeof InputSchema>;

export const LatestCommentSchema = z.object({
  comments: z.string().optional(),
  user_commenting: z.string().optional(),
  likes: z.number().optional(),
});
export type LatestComment = z.infer<typeof LatestCommentSchema>;

export const PartnershipDetailsSchema = z.object({
  profile_id: z.string().optional().nullable(),
  username: z.string().optional().nullable(),
  profile_url: z.string().optional().nullable(),
});
export type PartnershipDetails = z.infer<typeof PartnershipDetailsSchema>;

export const PostContentSchema = z.object({
  index: z.number().optional(),
  type: TypeSchema.optional(),
  url: z.string().optional(),
});
export type PostContent = z.infer<typeof PostContentSchema>;

export const TaggedUserSchema = z.object({
  full_name: z.string().optional(),
  id: z.string().optional(),
  is_verified: z.boolean().optional(),
  profile_pic_url: z.string().optional(),
  username: z.string().optional(),
});
export type TaggedUser = z.infer<typeof TaggedUserSchema>;

export const InstagramPostElementSchema = z.object({
  input: InputSchema.optional(),
  url: z.string().optional(),
  user_posted: z.string().optional(),
  description: z.string().optional(),
  post_id: z.string().optional(),
  post_content: z.array(PostContentSchema).optional(),
  timestamp: z.coerce.date().optional(),
});

export type InstagramPostElement = z.infer<typeof InstagramPostElementSchema>;

export const InstagramPostListSchema = z.array(InstagramPostElementSchema);
export type InstagramPostList = z.infer<typeof InstagramPostListSchema>;

// ---------------------------------------------------------------------------
// RapidAPI instagram120 types (mediaByShortcode / posts)
// ---------------------------------------------------------------------------

export const RapidApiMediaUrlSchema = z.object({
  url: z.string(),
  name: z.string().optional(),
  extension: z.string().optional(),
});

export const RapidApiMetaSchema = z.object({
  title: z.string().optional(),
  sourceUrl: z.string().optional(),
  shortcode: z.string().optional(),
  username: z.string().optional(),
  commentCount: z.number().optional(),
  likeCount: z.number().optional(),
  takenAt: z.number().optional(),
});

export const RapidApiMediaItemSchema = z.object({
  urls: z.array(RapidApiMediaUrlSchema),
  meta: RapidApiMetaSchema,
  pictureUrl: z.string().optional(),
});

export const RapidApiMediaResponseSchema = z.array(RapidApiMediaItemSchema);
export type RapidApiMediaItem = z.infer<typeof RapidApiMediaItemSchema>;
export type RapidApiMediaResponse = z.infer<typeof RapidApiMediaResponseSchema>;

