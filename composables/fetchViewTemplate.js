/**
 * Routed views ship HTML next to main.js and load it via fetch.
 * Guards against stalled / failed loads so Vue can still render a fallback shell.
 */

const FETCH_MS = 12_000;

/**
 * @param {string} importMetaUrl - pass `import.meta.url` from the view’s main.js
 * @param {string} relativePath - typically `"./index.html"`
 * @returns {Promise<string>}
 */
export async function fetchViewTemplate(importMetaUrl, relativePath = "./index.html") {
  const url = new URL(relativePath, importMetaUrl);
  url.searchParams.set(
    "v",
    globalThis.__CLUBCHAT_BUILD_ID || String(Date.now()),
  );
  /** @type {RequestInit | undefined} */
  const opts = { cache: "no-store" };
  try {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      opts.signal = AbortSignal.timeout(FETCH_MS);
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch (e) {
    console.warn("[ClubChat] view template fetch failed:", url.href, e);
    return `
<section class="panel route-page" aria-live="polite">
  <h2 class="route-page__title">Screen unavailable</h2>
  <p class="route-page__desc">
    Failed to load <code>${url.pathname.split("/").pop() ?? "template"}</code>.
    Try refreshing. If you're opening from a raw <code>file://</code> URL, serve the app over HTTP instead.
  </p>
</section>`;
  }
}
