/**
 * Automated SynXis login — ported from DualPMS/synxis.py populate_cookies().
 * LOCAL USE ONLY: run via npm run dev / scripts/local-synxis-sync.ts on the hotel PC.
 * Do NOT call from Supabase edge functions — SynXis blocks cloud IPs.
 */
import { type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  SynxisCookieJar,
  type StoredCookie,
  SYNXIS_USER_AGENT,
} from "./synxis-cookie-jar.ts";
import { waitForSynxisVerificationCode, clearGmailInbox } from "./synxis-imap.ts";
import { updateAppSettingsJson } from "./pms-board-db.ts";
import { validateSynxisCookieHeader } from "./synxis-room-sync.ts";
import { loadSynxisPropertyConfig } from "./synxis-secrets.ts";

export const SYNXIS_SESSION_KEY = "synxis_session";

const TIMEOUT_MS = 30_000;
const LOGIN_URL = "https://controlcenter-p2.synxis.com/cc/login.aspx?remoteLogin=1";

export type SynxisCredentials = {
  username: string;
  password: string;
  gmailAddress: string;
  gmailAppPassword: string;
  propertyId: string;
  chainId: string;
  shsTag: string;
};

export type SynxisStoredSession = {
  cookieHeader?: string;
  cookies?: StoredCookie[];
  refreshedAt?: string;
  source?: "manual" | "auto";
};

/** Strip optional "Cookie:" prefix from DevTools copy/paste. */
export function normalizeSynxisCookieHeader(raw: string): string {
  let header = raw.trim();
  if (/^cookie:\s*/i.test(header)) {
    header = header.replace(/^cookie:\s*/i, "");
  }
  return header.trim();
}

async function loadSynxisCredentials(
  serviceClient: SupabaseClient,
): Promise<SynxisCredentials | null> {
  try {
    const { loadSynxisIntegration, resolveSynxisCredentials } = await import(
      "./synxis-secrets.ts"
    );
    const integration = await loadSynxisIntegration(serviceClient);
    if (integration?.passwordEncrypted && integration.gmailAppPasswordEncrypted) {
      return await resolveSynxisCredentials(integration);
    }
  } catch (e) {
    console.warn("[synxis-session] app_settings credentials:", e);
  }
  return loadSynxisCredentialsFromEnv();
}

export function loadSynxisCredentialsFromEnv(): SynxisCredentials | null {
  const username = Deno.env.get("SYNXIS_USERNAME")?.trim();
  const password = Deno.env.get("SYNXIS_PASSWORD")?.trim();
  const gmailAddress = Deno.env.get("SYNXIS_GMAIL_ADDRESS")?.trim();
  const gmailAppPassword = Deno.env.get("SYNXIS_GMAIL_APP_PASSWORD")?.trim();
  if (!username || !password || !gmailAddress || !gmailAppPassword) return null;

  return {
    username,
    password,
    gmailAddress,
    gmailAppPassword,
    propertyId: Deno.env.get("SYNXIS_PROPERTY_ID")?.trim() || "93302",
    chainId: Deno.env.get("SYNXIS_CHAIN_ID")?.trim() || "5136",
    shsTag: Deno.env.get("SYNXIS_SHS_TAG")?.trim() || "3d41862e94058d16432e263a354fe8c1",
  };
}

async function loadStoredSession(serviceClient: SupabaseClient): Promise<SynxisStoredSession | null> {
  const { data, error } = await serviceClient
    .from("app_settings")
    .select("value")
    .eq("key", SYNXIS_SESSION_KEY)
    .maybeSingle();

  if (error) {
    console.warn("[synxis-session] load stored session:", error.message);
    return null;
  }

  const value = data?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as SynxisStoredSession;
}

async function saveStoredSession(
  serviceClient: SupabaseClient,
  jar: SynxisCookieJar,
  source: "manual" | "auto" = "auto",
): Promise<void> {
  await updateAppSettingsJson(serviceClient, SYNXIS_SESSION_KEY, {
    cookieHeader: jar.toHeaderString(),
    cookies: jar.toStored(),
    refreshedAt: new Date().toISOString(),
    source,
  });
}

/** DualPMS: parse only <input> fields from login page (ViewState, etc.). */
function parseLoginInputs(html: string): Record<string, string> {
  const data: Record<string, string> = {};
  const inputRe = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRe.exec(html)) !== null) {
    const tag = match[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) data[name] = value;
  }
  return data;
}

class SynxisLoginClient {
  constructor(
    private jar: SynxisCookieJar,
    private creds: SynxisCredentials,
  ) {}

  /** DualPMS requests.Session — User-Agent only, plus caller headers. */
  private async fetchWithJar(
    url: string,
    init: RequestInit & { form?: Record<string, string> },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": SYNXIS_USER_AGENT,
      ...(init.headers as Record<string, string> | undefined),
    };

    let body = init.body;
    if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let currentUrl = url;
      for (let hop = 0; hop < 10; hop++) {
        const hopHeaders = { ...headers };
        const cookieHeader = this.jar.cookieHeaderForUrl(currentUrl);
        if (cookieHeader) hopHeaders.Cookie = cookieHeader;

        const response = await fetch(currentUrl, {
          method: init.method ?? "GET",
          headers: hopHeaders,
          body: hop === 0 ? body : undefined,
          signal: controller.signal,
          redirect: "manual",
        });
        this.jar.ingestResponse(response, currentUrl);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) return response;
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        return response;
      }
      throw new Error("SynXis login exceeded redirect limit");
    } finally {
      clearTimeout(timer);
    }
  }

  /** DualPMS do_email_verification — Gmail inbox MFA. */
  private async doEmailVerification(securityToken2: string): Promise<string> {
    await clearGmailInbox(this.creds.gmailAddress, this.creds.gmailAppPassword);

    const res1 = await fetch(
      "https://security-p2.synxis.com/shs-security-services/v1/auth/mfa/token",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${securityToken2}`,
        },
        body: JSON.stringify({ Factor: "email", Device: "Email", IPAddress: "192.168.1.1" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res1.ok) {
      throw new Error(`SynXis MFA email request failed (HTTP ${res1.status})`);
    }
    const json1 = (await res1.json()) as { token?: string };
    if (!json1.token) throw new Error("SynXis MFA email request missing token");

    const verificationCode = await waitForSynxisVerificationCode(
      this.creds.gmailAddress,
      this.creds.gmailAppPassword,
      { attempts: 6, delayMs: 5000, sleepBeforeEachAttempt: true },
    );

    const res2 = await fetch(
      "https://security-p2.synxis.com/shs-security-services/v1/auth/mfa/token",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${json1.token}`,
        },
        body: JSON.stringify({
          Factor: "email_passcode",
          PassCode: verificationCode,
          IPAddress: "192.168.1.1",
          RememberMe: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res2.ok) {
      throw new Error(`SynXis MFA passcode failed (HTTP ${res2.status})`);
    }
    const json2 = (await res2.json()) as { access_token?: string };
    if (!json2.access_token) throw new Error("SynXis MFA passcode missing access_token");
    return json2.access_token;
  }

  /** DualPMS populate_cookies() — 9 steps, session jar populated for API calls. */
  async populateCookies(): Promise<void> {
    const loginGet = await this.fetchWithJar(LOGIN_URL, { method: "GET" });
    if (!loginGet.ok) {
      throw new Error(`SynXis login page HTTP ${loginGet.status}`);
    }

    const html = await loginGet.text();
    const form = parseLoginInputs(html);
    form["LoginCntrl$UsernameTextBox"] = this.creds.username;
    form["LoginCntrl$PasswordTextBox"] = this.creds.password;

    await this.fetchWithJar(LOGIN_URL, { method: "POST", form });
    console.log("[synxis-session] step2: posted username and password");

    let securityToken2 = this.jar.get("SecurityToken");
    if (!securityToken2) {
      const loginEmail = this.jar.get("LoginEmail");
      if (loginEmail?.startsWith("$shsenc")) {
        securityToken2 = loginEmail;
      }
    }
    if (!securityToken2) {
      throw new Error(
        "SynXis password step failed — verify username, password, and property ID in Admin → Settings",
      );
    }

    // DualPMS without_email_verification() is disabled — always use Gmail MFA.
    const securityToken4 = await this.doEmailVerification(securityToken2);

    await this.fetchWithJar(LOGIN_URL, {
      method: "POST",
      form: { SecurityToken: securityToken4 },
    });

    const iframeUrl =
      `https://sph.synxis.com/pms-web-ui/iframe-login?access_token=${
        encodeURIComponent(securityToken4)
      }&lang=&hotelId=${this.creds.propertyId}&chainId=${this.creds.chainId}&pageId=20082`;

    const iframeGet = await this.fetchWithJar(iframeUrl, {
      method: "GET",
      headers: { Referer: "https://controlcenter-p2.synxis.com" },
    });
    if (!iframeGet.ok) {
      throw new Error(`SynXis iframe-login HTTP ${iframeGet.status}`);
    }

    const contextSave = await fetch(
      "https://sph.synxis.com/pms-web-ui/service/v1/auth/context/save",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          Referer: iframeUrl,
          Cookie: this.jar.cookieHeaderForUrl(
            "https://sph.synxis.com/pms-web-ui/service/v1/auth/context/save",
          ),
        },
        body: JSON.stringify({
          payload: {
            token: securityToken4,
            chainId: this.creds.chainId,
            hotelId: this.creds.propertyId,
            pageId: "20082",
            isIframeLogin: true,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!contextSave.ok) {
      throw new Error(`SynXis auth/context/save HTTP ${contextSave.status}`);
    }
    this.jar.ingestResponse(contextSave, contextSave.url);

    const dashboardGet = await this.fetchWithJar(
      "https://sph.synxis.com/pms-web-ui/guest-mgt/dashboard?PropertyChanged",
      {
        method: "GET",
        headers: { referer: iframeUrl },
      },
    );
    if (!dashboardGet.ok) {
      throw new Error(`SynXis dashboard HTTP ${dashboardGet.status}`);
    }

    const contextPost = await fetch(
      "https://sph.synxis.com/pms-web-ui/service/v1/user/context",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          referer: "https://sph.synxis.com/pms-web-ui/guest-mgt/dashboard?PropertyChanged",
          TIMESTAMP: String(Date.now()),
          Cookie: this.jar.cookieHeaderForUrl(
            "https://sph.synxis.com/pms-web-ui/service/v1/user/context",
          ),
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!contextPost.ok) {
      throw new Error(`SynXis user/context HTTP ${contextPost.status}`);
    }
    this.jar.ingestResponse(contextPost, contextPost.url);

    console.log("[synxis-session] got cookies");
  }
}

/**
 * Returns a valid Cookie header.
 * 1. Reuse persisted session if still valid (like DualPMS cookies.pickle)
 * 2. Otherwise run populate_cookies() with DB credentials + Gmail MFA
 */
export async function ensureSynxisSession(
  serviceClient: SupabaseClient,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  const propertyConfig = await loadSynxisPropertyConfig(serviceClient);
  const stored = await loadStoredSession(serviceClient);

  const validate = (header: string) =>
    validateSynxisCookieHeader(normalizeSynxisCookieHeader(header), propertyConfig);

  if (!options?.forceRefresh) {
    const envCookie = Deno.env.get("SYNXIS_COOKIE_HEADER")?.trim();
    if (envCookie) {
      const normalized = normalizeSynxisCookieHeader(envCookie);
      if (await validate(normalized)) return normalized;
    }

    const storedHeader = stored?.cookieHeader?.trim();
    if (storedHeader) {
      const normalized = normalizeSynxisCookieHeader(storedHeader);
      if (await validate(normalized)) return normalized;
    }
  }

  const creds = await loadSynxisCredentials(serviceClient);
  if (!creds) {
    throw new Error(
      "SynXis credentials not configured — save username, password, and Gmail app password under Admin → Settings",
    );
  }

  const jar = new SynxisCookieJar();
  if (stored?.cookies?.length) {
    jar.loadStored(stored.cookies);
  }

  const client = new SynxisLoginClient(jar, creds);
  await client.populateCookies();

  const cookieHeader = jar.toHeaderString();
  if (!cookieHeader) {
    throw new Error("SynXis login completed but no cookies were captured");
  }

  if (!(await validateSynxisCookieHeader(cookieHeader, propertyConfig))) {
    throw new Error("SynXis login completed but session validation failed");
  }

  await saveStoredSession(serviceClient, jar, "auto");
  return cookieHeader;
}
