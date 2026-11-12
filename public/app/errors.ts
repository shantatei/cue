/** Normalize rejected promises and external API failures without assuming they throw Error. */
export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return new Error(value.message);
  return new Error(typeof value === "string" ? value : "Unknown error");
}
export const errorMessage = (value: unknown): string => asError(value).message;
export const isAbortError = (value: unknown): boolean => value instanceof Error && value.name === "AbortError";
export function errorStatus(value: unknown): number | undefined {
  return value && typeof value === "object" && "status" in value && typeof value.status === "number" ? value.status : undefined;
}
