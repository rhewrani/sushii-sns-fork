import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { MessageFlags, type MessageCreateOptions } from "discord.js";
import { platformToString, type Platform, type PostData, type SnsMetadata } from "../platforms/base";
import { itemsToMessageContents, KST_TIMEZONE } from "./discord";

dayjs.extend(utc);
dayjs.extend(timezone);

export const DEFAULT_LINKS_TEMPLATE =
  "`{date_kst} {username} {platform} Update`\n<{post_url}>\n{links}";

export const DEFAULT_INLINE_TEMPLATE =
  "`{date_kst} {username} {platform} Update`\n<{post_url}>\n{caption}";

export type TemplateVars = {
  dateKst: string;
  username: string;
  postUrl: string;
  caption: string;
  platform: string;
  links?: string;
};

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{date_kst\}/g, vars.dateKst)
    .replace(/\{username\}/g, vars.username)
    .replace(/\{post_url\}/g, vars.postUrl)
    .replace(/\{caption\}/g, vars.caption)
    .replace(/\{platform\}/g, vars.platform)
    .replace(/\{links\}/g, vars.links ?? "");
}

export function buildTemplateVars(
  postData: PostData<SnsMetadata>,
  cdnUrls?: string[],
): TemplateVars {
  const platform = postData.postLink.metadata.platform;
  const platformName = platformToString(platform);
  const dateKst = postData.timestamp
    ? dayjs(postData.timestamp).tz(KST_TIMEZONE).format("YYMMDD")
    : "";

  return {
    dateKst,
    username: postData.username,
    postUrl: postData.postLink.url,
    caption: postData.originalText,
    platform: platformName,
    links: cdnUrls ? cdnUrls.join("\n") : undefined,
  };
}

/**
 * For "links" format: splits template at {links}, uses itemsToMessageContents()
 * so CDN URL overflow across messages still works at the 2000-char limit.
 */
export function buildLinksFormatMessages(
  template: string,
  postData: PostData<SnsMetadata>,
  cdnUrls: string[],
): MessageCreateOptions[] {
  const vars = buildTemplateVars(postData, cdnUrls);

  // Split template at {links} to get the prefix (everything before {links})
  const linksPlaceholder = "{links}";
  const linksIdx = template.indexOf(linksPlaceholder);

  if (linksIdx === -1) {
    // No {links} in template — render as-is, no CDN URL chunking
    const content = renderTemplate(template, vars).slice(0, 2000);
    return [{ content, flags: MessageFlags.SuppressEmbeds }];
  }

  const prefix = renderTemplate(template.slice(0, linksIdx), vars);
  const suffix = template.slice(linksIdx + linksPlaceholder.length);
  const renderedSuffix = suffix
    ? renderTemplate(suffix, vars)
    : "";

  // Use itemsToMessageContents to handle CDN URL overflow
  const chunks = itemsToMessageContents(prefix, cdnUrls);

  return chunks.map((chunk, i) => {
    // Append suffix to last chunk
    const content = i === chunks.length - 1 ? chunk + renderedSuffix : chunk;
    return {
      content: content.slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    };
  });
}

/**
 * For "inline" format: renders template with {links} → "", slices to 2000 chars.
 * Returns content string — caller handles attachment chunking.
 */
export function buildInlineFormatContent(
  template: string,
  postData: PostData<SnsMetadata>,
): string {
  const vars = buildTemplateVars(postData);
  return renderTemplate(template, vars).slice(0, 2000);
}
