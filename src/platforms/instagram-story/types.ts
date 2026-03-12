import * as z from "zod";

export const UserSchema = z.object({
  full_name: z.string().optional(),
  id: z.string().optional(),
  is_private: z.boolean().optional(),
  is_verified: z.boolean().optional(),
  profile_pic_id: z.string().optional(),
  profile_pic_url: z.string().optional(),
  username: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const AdditionalDataSchema = z.object({
  ad_expiry_timestamp_in_millis: z.null().optional(),
  app_sticker_info: z.null().optional(),
  can_gif_quick_reply: z.boolean().optional(),
  can_react_with_avatar: z.boolean().optional(),
  can_reply: z.boolean().optional(),
  can_reshare: z.boolean().optional(),
  disabled_reply_types: z.array(z.string()).optional(),
  expiring_at: z.number().optional(),
  id: z.string().optional(),
  is_cta_sticker_available: z.null().optional(),
  is_nux: z.boolean().optional(),
  latest_reel_media: z.number().optional(),
  reel_type: z.string().optional(),
  should_treat_link_sticker_as_cta: z.null().optional(),
  show_fan_club_stories_teaser: z.boolean().optional(),
  user: UserSchema.optional(),
});
export type AdditionalData = z.infer<typeof AdditionalDataSchema>;

export const ImageVersionsItemSchema = z.object({
  height: z.number().optional(),
  url: z.string().optional(),
  width: z.number().optional(),
});
export type ImageVersionsItem = z.infer<typeof ImageVersionsItemSchema>;

export const VideoVersionSchema = z.object({
  height: z.number().optional(),
  id: z.string().optional(),
  type: z.number().optional(),
  url: z.string().optional(),
  width: z.number().optional(),
});
export type VideoVersion = z.infer<typeof VideoVersionSchema>;

export const ImageVersionsSchema = z.object({
  items: z.array(ImageVersionsItemSchema).optional(),
});
export type ImageVersions = z.infer<typeof ImageVersionsSchema>;

export const OwnerSchema = z.object({
  profile_pic_url: z.string().optional(),
  username: z.string().optional(),
});
export type Owner = z.infer<typeof OwnerSchema>;

export const StoryItemSchema = z.object({
  // Is user and owner always the same?
  user: OwnerSchema.optional(),
  owner: OwnerSchema.optional(),
  taken_at_date: z.coerce.date().optional(),

  // Is thumbnail_url always the max resolution?
  thumbnail_url: z.string().optional(),
  image_versions: ImageVersionsSchema.optional(),

  is_video: z.boolean().optional(),
  video_url: z.string().optional(),
});
export type StoryItem = z.infer<typeof StoryItemSchema>;

export const DataSchema = z.object({
  additional_data: AdditionalDataSchema.optional(),
  count: z.number().optional(),
  items: z.array(StoryItemSchema).optional(),
});
export type Data = z.infer<typeof DataSchema>;

export const IgStoriesSchema = z.object({
  data: DataSchema.optional(),
});
export type IgStories = z.infer<typeof IgStoriesSchema>;
