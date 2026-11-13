import type { Chapter, HeatmapPoint } from "../public/app/types.js";

export interface Thumbnail { url: string; width?: number; height?: number; id?: string }
export interface RawFormat {
  format_id: string; protocol?: string; url: string; manifest_url?: string; has_drm?: boolean; available_at?: number;
  ext?: string; vcodec?: string; acodec?: string; dynamic_range?: string; format_note?: string;
  height?: number; width?: number; fps?: number; tbr?: number; abr?: number; language_preference?: number; filesize?: number; filesize_approx?: number;
}
export interface RawCaption { url: string; ext: string; name?: string }
export interface RawComment {
  id: string; author: string; author_thumbnail?: string; text: string; like_count?: number;
  timestamp?: number; author_is_uploader?: boolean; is_pinned?: boolean; is_favorited?: boolean; parent?: string;
}
export interface YtEntry {
  id: string; title?: string; description?: string; channel?: string; uploader?: string; channel_id?: string;
  uploader_id?: string; channel_is_verified?: boolean; channel_follower_count?: number;
  duration?: number; view_count?: number; timestamp?: number; thumbnail?: string; thumbnails?: Thumbnail[];
  live_status?: string; is_live?: boolean; url?: string; tags?: string[]; categories?: string[];
}
export interface YtResult extends YtEntry {
  entries?: YtEntry[]; formats?: RawFormat[]; comments?: RawComment[]; comment_count?: number; like_count?: number;
  language?: string; chapters?: Chapter[]; heatmap?: HeatmapPoint[];
  subtitles?: Record<string, RawCaption[]>; automatic_captions?: Record<string, RawCaption[]>;
}
/** yt-dlp's JSON is the external boundary; callers work with its documented metadata shape. */
export const parseYtJSON = (text: string): YtResult => JSON.parse(text) as YtResult;
export type Ytdlp = (args: string[]) => Promise<string>;
