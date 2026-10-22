/**
 * Bilibili QR-code login and a local SESSDATA credential store for dsh-bilibili.
 *
 * Login flow adapted from Tsuk1ko/bilibili-qr-login (MIT) — endpoints, status
 * codes and the crossDomain credential parsing follow that project's usage;
 * see THIRD_PARTY_NOTICES.md.
 *
 * Credentials are stored as plaintext JSON at <plugin root>/.sessdata.json
 * (git-ignored, owner-only 0600). Never return the raw SESSDATA to the caller.
 *
 * The QR code is rendered locally (qrcode package): the login URL carries the
 * qrcode_key, and anyone holding it could poll for the cookies after the user
 * confirms, so it must never be sent to a third-party QR image service.
 *
 * @module dsh-bilibili/login
 */
import { chmod, readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

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

/** Write a credential-bearing file readable by the owner only. */
async function writePrivateFile(path, text) {
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {}); // mode only applies on create; tighten pre-existing files too
}

/** Generate a login QR code locally: scan URL, a text (Unicode block) rendering and a local PNG path. */
export async function startQrLogin() {
  const resp = await fetch(PASSPORT_BASE + "/qrcode/generate?source=main-fe-header", { headers: HEADERS });
  const json = await resp.json().catch(() => ({}));
  if (json.code !== 0) throw new Error("二维码生成失败：" + (json.message ?? json.code));
  const url = json.data?.url ?? "";
  const key = json.data?.qrcode_key ?? "";
  if (!url || !key) throw new Error("二维码接口返回异常（无 url / qrcode_key）");
  const qrText = await QRCode.toString(url, { type: "utf8", margin: 2 });
  let savedPath = "";
  try {
    await QRCode.toFile(QR_PNG_FILE, url, { margin: 2, width: 320 });
    await chmod(QR_PNG_FILE, 0o600).catch(() => {}); // the QR encodes the qrcode_key too
    savedPath = QR_PNG_FILE;
  } catch {
    // local PNG save is best-effort; the text rendering still works
  }
  return {
    qrcode_key: key,
    login_url: url,
    qr_text: qrText,
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
    return { status: map[json.code] ?? "error", code: json.code ?? -1, message: json.message ?? "" };
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
        // shape only: the payload can still carry refresh_token or partial cookies
        await writePrivateFile(
          join(PLUGIN_ROOT, ".qr-login-debug.json"),
          JSON.stringify({
            code: json.code,
            data_keys: Object.keys(data),
            url_host: (() => { try { return new URL(String(data.url)).host; } catch { return ""; } })(),
            set_cookie_names: setCookies.map((c) => String(c).split("=")[0]),
          }, null, 2),
        );
      } catch {
        // debug dump is best-effort
      }
      return { status: "error", code: 0, message: "登录成功但响应中未找到 SESSDATA（响应结构已脱敏转储到 .qr-login-debug.json）" };
    }
    await writePrivateFile(
      CRED_FILE,
      JSON.stringify({ ...creds, saved_at: new Date().toISOString() }, null, 2),
    );
    return { status: "success", code: 0, dedeuserid: creds.dedeuserid, saved: true, message: "" };
  }
  return { status: map[data.code] ?? "error", code: data.code ?? -1, message: data.message ?? "" };
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
  await writePrivateFile(
    CRED_FILE,
    JSON.stringify({ sessdata: clean, bili_jct: "", dedeuserid: "", saved_at: new Date().toISOString() }, null, 2),
  );
  return true;
}

/** Delete stored credentials and the QR image file. */
export async function clearCredentials() {
  let cleared = false;
  try {
    await stat(CRED_FILE);
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
