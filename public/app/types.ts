export interface Channel { id: string; name: string; avatar?: string | null; handle?: string | null; subs?: number | null; verified?: boolean }
export interface Group { id: string; name: string; code?: string }
export interface Video {
  id: string; title?: string; channel?: string | null; channelId?: string | null;
  thumbnail?: string | null; description?: string | null; duration?: number | null;
  verified?: boolean; views?: number | null; timestamp?: number | null; live?: boolean; short?: boolean;
  ch?: Channel | null; group?: Group; tags?: unknown; categories?: unknown; hashtags?: unknown;
}
export interface Subscription { name: string; group: Group; channelId?: string | null; ch?: Channel | null; fresh: boolean }
export interface AccountStatus { connected: boolean; needsReconnect?: boolean; browser?: string; since?: number; error?: string | null }
export interface AccountRaw { channels: Channel[]; subsFeed: Video[]; home: Video[] }
export interface AppData {
  groups: Group[]; subs: Subscription[]; videos: Video[]; shorts: Video[];
  channels: Map<string, Channel>; fresh: Set<string | null | undefined>;
  home?: Video[]; live?: boolean; account?: AccountStatus;
  onUpdate?: (fn: (kind: "updated" | "error", error?: Error) => void) => () => boolean;
  refresh?: () => Promise<void>; staleFor?: () => number;
}
export interface Fixture {
  groups: Group[]; channels: Channel[]; videos: Video[]; shorts: Video[];
  subscriptions: { name: string; group: string; channelId?: string | null }[];
}
export interface StreamFormat { id: string; mime: string; bitrate?: number }
export interface VideoFormat extends StreamFormat { quality: number; width: number; height: number; fps: number; bitrate: number }
export interface Chapter { start_time: number; end_time?: number; title: string }
export interface HeatmapPoint { start_time: number; end_time: number; value: number }
export interface CaptionTrack { id: string; lang: string; name: string; kind: "manual" | "auto" }
export interface VideoInfo extends Omit<Video, "title" | "channel" | "duration" | "tags" | "categories"> {
  title: string; channel: string; duration: number; handle?: string | null;
  verified: boolean; subscribers?: number | null; likes?: number | null; comments?: number | null;
  video: VideoFormat[]; audio: StreamFormat[]; muxed: VideoFormat[];
  tags: string[]; categories: string[]; chapters: Chapter[]; heatmap: HeatmapPoint[];
  language?: string | null; captions: CaptionTrack[];
}
export interface VideoComment { id: string; author: string; avatar?: string | null; text: string; likes: number; timestamp?: number | null; byUploader?: boolean; pinned?: boolean; hearted?: boolean }
export interface RecommendationPage { videos: Video[]; nextCursor: string | null }
export interface WorkerPage { videos: Video[]; hasMore: boolean }
export interface PlaybackPrefs { autoplay: boolean; maxQuality: number; rate: number; volume: number; muted: boolean; resume: boolean }
export interface AppSettings { theme: "dark" | "light" | "system"; playback: PlaybackPrefs; captions: { show: "off" | "on"; language: string; size: number; background: number } }
export interface CaptionChoice { id: string; url: string; label: string; note?: string; lang: string; kind: "manual" | "auto" }
export interface CaptionRequest {
  id: string; task: "transcribe" | "translate"; label: string; note?: string;
  cached?: boolean; auto?: boolean; beforeAuto?: boolean;
  start: (report: (message: string) => void) => Promise<string>;
}
export interface CaptionOptions {
  tracks?: CaptionChoice[]; requests?: CaptionRequest[]; initial?: string | null;
  size?: number; background?: number; emptyHint?: string;
  onChoose?: (id: string, choice: CaptionChoice | CaptionRequest | undefined) => void;
}
export interface PlayerOptions {
  autoplay?: boolean; startAt?: number; prefs?: PlaybackPrefs; savePrefs?: () => void;
  onTime?: (time: number, duration: number) => void; onEnded?: () => void; captions?: CaptionOptions;
}
export interface PlayerAPI { key: (event: KeyboardEvent) => boolean; seek: (time: number) => void; readonly time: number; captions: (id: string | null) => Promise<void>; readonly quality: string | null; destroy: () => void }
export type SettingValue = string | number | boolean;
export interface ExtensionContext { info: VideoInfo; data: AppData; readonly player: PlayerAPI | null }
export interface ExtensionAPI {
  id: string;
  settings: { get: (key: string) => SettingValue | undefined; set: (key: string, value: SettingValue) => void };
  storage: { get: <T>(key: string, fallback: T) => T; set: (key: string, value: unknown) => boolean };
  player: () => PlayerAPI | null;
  toast: (message: string) => void; icon: (name: string, size?: number) => string;
  esc: (value: unknown) => string; compact: (value: number | null | undefined) => string;
  fmtTime: (value: number | null | undefined) => string; ago: (timestamp?: number | null) => string;
}
export interface ExtensionSetting { key: string; type: "toggle" | "select"; label: string; default: SettingValue; options?: [SettingValue, string][] }
export interface ExtensionPanel { id: string; render: (context: ExtensionContext, api: ExtensionAPI) => string; mount?: (root: HTMLElement, context: ExtensionContext, api: ExtensionAPI) => void }
export interface Extension {
  id: string; name: string; version?: string; author?: string; description?: string; icon?: string;
  permissions?: string[]; settings?: ExtensionSetting[]; builtin?: boolean; broken?: boolean; url?: string;
  topbar?: { icon?: string; label: string; title?: string; onClick?: (api: ExtensionAPI) => void };
  watchPanels?: ExtensionPanel[]; captionRequests?: (context: ExtensionContext, api: ExtensionAPI) => Promise<CaptionRequest[]>;
}
export interface PageElement extends HTMLElement { _off?: AbortController; _cleanup?: (() => void) | null }
export interface Profile { id: string; name: string; color: string }
export interface AIStatus { available: boolean; state?: "idle" | "queued" | "running" | "done" | "error"; stage?: string; progress?: number; error?: string }
