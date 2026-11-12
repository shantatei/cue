export const SEARCH_OPTIONS = {
  type: [["all", "All"], ["videos", "Videos"], ["shorts", "Shorts"]],
  date: [["any", "Any time"], ["today", "Today"], ["week", "This week"], ["month", "This month"], ["year", "This year"]],
  duration: [["any", "Any duration"], ["short", "Under 3 minutes"], ["medium", "3–20 minutes"], ["long", "Over 20 minutes"]],
  sort: [["relevance", "Relevance"], ["date", "Upload date"], ["popularity", "Popularity"]],
  watched: [["all", "All"], ["watched", "Watched"], ["unwatched", "Unwatched"]],
};
export const SEARCH_CHIPS = [["all", "All"], ["shorts", "Shorts"], ["unwatched", "Unwatched"], ["watched", "Watched"], ["videos", "Videos"], ["recent", "Recently uploaded"], ["live", "Live"]];
export function normalizeSearchFilters(raw = {}) {
  const filters = Object.fromEntries(Object.entries(SEARCH_OPTIONS).map(([key, choices]) => [key, choices.some(([id]) => raw[key] === id) ? raw[key] : choices[0][0]]));
  for (const flag of ["live", "hd", "uhd", "cc"]) filters[flag] = raw[flag] === true || raw[flag] === "1";
  return filters;
}
export function quickSearchFilter(chip) {
  const filters = normalizeSearchFilters();
  if (["videos", "shorts"].includes(chip)) filters.type = chip;
  if (["watched", "unwatched"].includes(chip)) filters.watched = chip;
  if (chip === "recent") filters.sort = "date";
  if (chip === "live") filters.live = true;
  return filters;
}
export const filterWatched = (videos, filters, history) => videos.filter((v) => filters.watched === "all" || history.has(v.id) === (filters.watched === "watched"));
