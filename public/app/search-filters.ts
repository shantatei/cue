import type { Video } from "./types.js";
export interface SearchFilters {
  type: "all" | "videos" | "shorts";
  date: "any" | "today" | "week" | "month" | "year";
  duration: "any" | "short" | "medium" | "long";
  sort: "relevance" | "date" | "popularity";
  watched: "all" | "watched" | "unwatched";
  live: boolean; hd: boolean; uhd: boolean; cc: boolean;
}
export const SEARCH_OPTIONS = {
  type: [["all", "All"], ["videos", "Videos"], ["shorts", "Shorts"]],
  date: [["any", "Any time"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["year", "This year"]],
  duration: [["any", "Any duration"], ["short", "Under 3 minutes"], ["medium", "3–20 minutes"], ["long", "Over 20 minutes"]],
  sort: [["relevance", "Relevance"], ["date", "Upload date"], ["popularity", "Popularity"]],
  watched: [["all", "All"], ["watched", "Watched"], ["unwatched", "Unwatched"]],
} as const;
export const SEARCH_CHIPS = [["all", "All"], ["shorts", "Shorts"], ["unwatched", "Unwatched"], ["watched", "Watched"], ["videos", "Videos"], ["recent", "Recently uploaded"], ["live", "Live"]];
export function normalizeSearchFilters(raw: Record<string, unknown> = {}): SearchFilters {
  const filters = Object.fromEntries(Object.entries(SEARCH_OPTIONS).map(([key, choices]) => [key, choices.some(([id]) => raw[key] === id) ? raw[key] : choices[0][0]])) as unknown as SearchFilters;
  for (const flag of ["live", "hd", "uhd", "cc"] as const) filters[flag] = raw[flag] === true || raw[flag] === "1";
  return filters;
}
export function quickSearchFilter(chip: string) {
  const filters = normalizeSearchFilters();
  if (["videos", "shorts"].includes(chip)) filters.type = chip as SearchFilters["type"];
  if (["watched", "unwatched"].includes(chip)) filters.watched = chip as SearchFilters["watched"];
  if (chip === "recent") filters.sort = "date";
  if (chip === "live") filters.live = true;
  return filters;
}
export const filterWatched = <T extends Pick<Video, "id">>(videos: T[], filters: SearchFilters, history: ReadonlySet<string>) => videos.filter((v) => filters.watched === "all" || history.has(v.id) === (filters.watched === "watched"));
