import type { CookieOptions, Response } from "express";

export const ACCESS_COOKIE = "nsi_access";
export const REFRESH_COOKIE = "nsi_refresh";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function baseCookieOptions(): CookieOptions {
  const sameSiteEnv = process.env.COOKIE_SAME_SITE?.toLowerCase();
  const isProduction = process.env.NODE_ENV === "production";

  const sameSite: CookieOptions["sameSite"] =
    sameSiteEnv === "lax" || sameSiteEnv === "strict" || sameSiteEnv === "none"
      ? sameSiteEnv
      : isProduction
        ? "none"
        : "lax";

  const secure =
    process.env.COOKIE_SECURE === "false"
      ? false
      : process.env.COOKIE_SECURE === "true" || isProduction
        ? true
        : false;

  const options: CookieOptions = {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
  };

  const domain = process.env.COOKIE_DOMAIN?.trim();
  if (domain) {
    options.domain = domain;
  }

  return options;
}

export function accessCookieOptions(): CookieOptions {
  return {
    ...baseCookieOptions(),
    maxAge: ACCESS_MAX_AGE_MS,
  };
}

export function refreshCookieOptions(): CookieOptions {
  return {
    ...baseCookieOptions(),
    maxAge: REFRESH_MAX_AGE_MS,
  };
}

export function clearAuthCookies(res: Response) {
  const clearOpts: CookieOptions = {
    ...baseCookieOptions(),
    maxAge: 0,
  };
  res.clearCookie(ACCESS_COOKIE, clearOpts);
  res.clearCookie(REFRESH_COOKIE, clearOpts);
}

export function setAccessCookie(res: Response, token: string) {
  res.cookie(ACCESS_COOKIE, token, accessCookieOptions());
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}
