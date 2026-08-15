/**
 * Bilibili QR-code login and a local SESSDATA credential store for dsh-bilibili.
 *
 * Login flow adapted from Tsuk1ko/bilibili-qr-login (MIT) — endpoints, status
 * codes and the crossDomain credential parsing follow that project's usage;
 * see THIRD_PARTY_NOTICES.md.
 *
 * Credentials are stored as plaintext JSON at <plugin root>/.sessdata.json
 * (git-ignored). Never return the raw SESSDATA to the caller.
 *
 * @module dsh-bilibili/login
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRED_FILE = join(PLUGIN_ROOT, ".sessdata.json");
const QR_PNG_FILE = join(PLUGIN_ROOT, ".qr-login.png");

const PASSPORT_BASE = "https://passport.bilibili.com/x/passport-login/web";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Origin: "https://www.bilibili.com",
  Referer: "https://www.bilibili.com/",
};

/** Generate a login QR code: scan URL, renderable QR image URLs and a local PNG path (best-effort). */
export async function startQrLogin() {
  const resp = await fetch(PASSPORT_BASE + "/qrcode/generate?source=main-fe-header", { headers: HEADERS });
  const json = await resp.json().catch(() => ({}));
  if (json.code !== 0) throw new Error("二维码生成失败：" + (json.message ?? json.code));
  const url = json.data?.url ?? "";
  const key = json.data?.qrcode_key ?? "";
  if (!url || !key) throw new Error("二维码接口返回异常（无 url / qrcode_key）");
  const qrImageUrl =
    "https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=" + encodeURIComponent(url);
  const qrImageUrlAlt = "https://api.liantu.com/api.php?text=" + encodeURIComponent(url);
  let savedPath = "";
  try {
    const img = await fetch(qrImageUrl, { signal: AbortSignal.timeout(15000) });
    if (img.ok) {
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > 500) {
        await writeFile(QR_PNG_FILE, buf);
        savedPath = QR_PNG_FILE;
      }
    }
  } catch {
    // local PNG save is best-effort; the returned image URL still works
  }
  return {
    qrcode_key: key,
    login_url: url,
    qr_image_url: qrImageUrl,
    qr_image_url_alt: qrImageUrlAlt,
    qr_image_path: savedPath,
  };
}

/** Try to decode a percent-encoded string without throwing. */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Extract credentials from the success payload: the classic crossDomain URL,
 * possibly nested inside another redirect param (new account.bilibili.com flow).
 * Returns null when no SESSDATA can be found anywhere.
 */
function findTokens(urlText) {
  const queue = [String(urlText ?? "")];
  const seen = new Set();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const sessdata = parsed.searchParams.get("SESSDATA");
    if (sessdata) {
      return {
        sessdata,
        bili_jct: parsed.searchParams.get("bili_jct") ?? "",
        dedeuserid: parsed.searchParams.get("DedeUserID") ?? "",
      };
    }
    for (const value of parsed.searchParams.values()) {
      const decoded = safeDecode(value);
      if (/crossDomain|SESSDATA|passport/i.test(decoded)) queue.push(decoded);
    }
  }
  return null;
}

/** Extract cookie pairs (name=value) from Set-Cookie header lines. */
function parseSetCookies(setCookies) {
  const jar = {};
  for (const line of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(line).split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return jar;
}

/**
 * Poll the QR login status once. On success, saves credentials locally and
 * returns status "success" (never the raw cookie).
 */
export async function pollQrLogin(qrcodeKey) {
  const resp = await fetch(
    PASSPORT_BASE + "/qrcode/poll?qrcode_key=" + encodeURIComponent(String(qrcodeKey)) + "&source=main-fe-header",
    { headers: HEADERS },
  );
  const setCookies = typeof resp.headers?.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  const json = await resp.json().catch(() => ({}));
  const map = { 86101: "waiting", 86090: "scanned", 86038: "expired" };
  // the outer code can carry the status directly (e.g. 86038 expired)
  if (json.code !== 0) {
    return { status: map[json.code] ?? "error", code: json.code, message: json.message ?? "" };
  }
  const data = json.data ?? {};
  if (data.code === 0) {
    // tokens usually arrive in the crossDomain redirect URL, possibly nested;
    // fall back to Set-Cookie headers of the poll response itself
    let creds = findTokens(data.url);
    if (!creds?.sessdata) {
      const jar = parseSetCookies(setCookies);
      if (jar.SESSDATA) {
        creds = { sessdata: jar.SESSDATA, bili_jct: jar.bili_jct ?? "", dedeuserid: jar.DedeUserID ?? "" };
      }
    }
    if (!creds?.sessdata) {
      try {
        await writeFile(
          join(PLUGIN_ROOT, ".qr-login-debug.json"),
          JSON.stringify({ raw: json, set_cookies: setCookies }, null, 2),
          "utf8",
        );
      } catch {
        // debug dump is best-effort
      }
      return { status: "error", code: 0, message: "登录成功但响应中未找到 SESSDATA（原始响应已转储到 .qr-login-debug.json）" };
    }
    await writeFile(
      CRED_FILE,
      JSON.stringify({ ...creds, saved_at: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return { status: "success", code: 0, dedeuserid: creds.dedeuserid, saved: true, message: "" };
  }
  return { status: map[data.code] ?? "error", code: data.code, message: data.message ?? "" };
}

/** Read the stored credentials, or null when absent / unreadable. */
export async function loadStoredSessdata() {
  try {
    const data = JSON.parse(await readFile(CRED_FILE, "utf8"));
    if (typeof data?.sessdata === "string" && data.sessdata) return data;
    return null;
  } catch {
    return null;
  }
}

/** Save a manually provided SESSDATA value (browser-copied cookie). */
export async function saveManualSessdata(sessdata) {
  const clean = String(sessdata).trim().replace(/^SESSDATA=/i, "");
  if (!clean) throw new Error("sessdata 为空");
  await writeFile(
    CRED_FILE,
    JSON.stringify({ sessdata: clean, bili_jct: "", dedeuserid: "", saved_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return true;
}

/** Delete stored credentials and the QR image file. */
export async function clearCredentials() {
  let cleared = false;
  try {
    await rm(CRED_FILE, { force: true });
    cleared = true;
  } catch {
    // already absent
  }
  try {
    await rm(QR_PNG_FILE, { force: true });
  } catch {
    // already absent
  }
  return cleared;
}

/** Report login status without exposing the credential. */
export async function credentialStatus() {
  const data = await loadStoredSessdata();
  if (!data) return { logged_in: false, message: "尚未登录（未找到本地凭证）" };
  const s = data.sessdata;
  const masked = s.length > 8 ? s.slice(0, 4) + "…" + s.slice(-4) : "…";
  return {
    logged_in: true,
    dedeuserid: data.dedeuserid || "",
    saved_at: data.saved_at || "",
    masked_sessdata: masked,
    message: "已登录。SESSDATA 已脱敏显示。",
  };
}
