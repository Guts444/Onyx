const REDACTED_VALUE = "redacted";
const SENSITIVE_QUERY_KEY = /^(?:access_?token|api_?key|auth|authorization|credential|key|pass|password|secret|signature|token|user|username)$/i;
const XTREAM_PATH_KIND = /^(?:live|movie|series)$/i;
const EMBEDDED_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const ENCODED_PATH_HAZARD = /%(?:2e|252e|252f|255c)/i;

export function decodeSafePathSegments(value: string) {
  if (/%(?![0-9a-f]{2})/i.test(value) || ENCODED_PATH_HAZARD.test(value)) {
    throw new Error("Unsafe URL path encoding.");
  }
  return value.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (
      decoded === "." || decoded === ".." ||
      CONTROL_CHARACTER.test(decoded) || /%[0-9a-f]{2}/i.test(decoded)
    ) throw new Error("Unsafe URL path segment.");
    return decoded;
  });
}

function originalPath(value: string) {
  const authorityIndex = value.indexOf("//");
  const pathIndex = value.indexOf("/", authorityIndex + 2);
  if (pathIndex < 0) return "/";
  return value.slice(pathIndex).split(/[?#]/, 1)[0];
}

function redactInvalidPath(url: URL) {
  url.username = url.username ? REDACTED_VALUE : "";
  url.password = url.password ? REDACTED_VALUE : "";
  url.pathname = "/redacted-invalid-path";
  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, REDACTED_VALUE);
  }
  return url.href;
}

export function redactCredentialUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return value; }

  let decodedSegments: string[];
  try { decodedSegments = decodeSafePathSegments(originalPath(value)); }
  catch { return redactInvalidPath(url); }

  if (url.username) url.username = REDACTED_VALUE;
  if (url.password) url.password = REDACTED_VALUE;

  const pathSegments = url.pathname.split("/");
  const xtreamKindIndex = decodedSegments.findIndex((segment) => XTREAM_PATH_KIND.test(segment));
  const unsafeSeparatorIndex = decodedSegments.findIndex((segment, index) =>
    (segment.includes("/") || segment.includes("\\")) &&
    (xtreamKindIndex < 0 || (index !== xtreamKindIndex + 1 && index !== xtreamKindIndex + 2)),
  );
  if (unsafeSeparatorIndex >= 0) return redactInvalidPath(url);
  if (xtreamKindIndex >= 0 && pathSegments.length > xtreamKindIndex + 3) {
    pathSegments[xtreamKindIndex] = decodedSegments[xtreamKindIndex].toLowerCase();
    pathSegments[xtreamKindIndex + 1] = REDACTED_VALUE;
    pathSegments[xtreamKindIndex + 2] = REDACTED_VALUE;
    url.pathname = pathSegments.join("/");
  }

  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, REDACTED_VALUE);
  }
  return url.href;
}

export function redactCredentials(value: string) {
  return value.replace(EMBEDDED_URL, (matchedUrl) => {
    let url = matchedUrl;
    let trailing = "";
    while (/[),.;!?]$/.test(url)) {
      trailing = `${url.slice(-1)}${trailing}`;
      url = url.slice(0, -1);
    }
    return `${redactCredentialUrl(url)}${trailing}`;
  });
}
