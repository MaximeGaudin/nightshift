// Provider tokens, stored in the global ~/.nightshift/settings.json (never in nightshift.json).
import { tokenKey } from "../../shared/issues.ts";
import { getIssueToken, setIssueToken } from "../settings.ts";

export function getToken(provider: string, baseUrl: string): string | undefined {
  return getIssueToken(tokenKey(provider, baseUrl));
}

export function hasToken(provider: string, baseUrl: string): boolean {
  return getToken(provider, baseUrl) !== undefined;
}

/** An empty token removes the saved one. */
export function setToken(provider: string, baseUrl: string, token: string) {
  setIssueToken(tokenKey(provider, baseUrl), token);
}
