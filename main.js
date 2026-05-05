import { createApp, provide } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
import { GraffitiLocal } from "@graffiti-garden/implementation-local";
import { GraffitiPlugin } from "@graffiti-garden/wrapper-vue";

// Graffiti session is per-origin; localhost / LAN preview ≠ github.io.
// GraffitiLocal on loopback + private HTTP LAN hosts for dev (see resolve… below).
// Force decentralized: ?decentralized=1 before the hash (index.html?decentralized=1#/).
function resolveGraffitiImplementation() {
  if (typeof location === "undefined") return new GraffitiDecentralized();
  const params = new URLSearchParams(location.search);
  if (
    params.has("decentralized") ||
    params.get("graffiti") === "decentralized"
  ) {
    return new GraffitiDecentralized();
  }
  const { hostname: h, protocol } = location;
  const loopback =
    h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  /** Live Server “Go Live” on LAN uses e.g. 192.168.x.x */
  const privateLan =
    protocol === "http:" &&
    /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
      h,
    );
  if (loopback || privateLan) return new GraffitiLocal();
  return new GraffitiDecentralized();
}

const BUILD_ID = globalThis.__CLUBCHAT_BUILD_ID || String(Date.now());
const { CLUB_KEY, useClubChat } = await import(
  `./composables/useClubChat.js?v=${BUILD_ID}`
);

function loadComponent(name) {
  return () =>
    import(`./views/${name}/main.js?v=${BUILD_ID}`).then((m) => m.default());
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: loadComponent("home") },
    {
      path: "/chat/:chatId",
      name: "chat",
      component: loadComponent("home"),
      props: true,
    },
    { path: "/profile", name: "profile", component: loadComponent("profile") },
    { path: "/newchat", name: "newchat", component: loadComponent("newchat") },
    { path: "/explore", name: "explore", component: loadComponent("explore") },
  ],
});

const app = createApp({
  template: "#template",
  setup() {
    const ctx = useClubChat();
    provide(CLUB_KEY, ctx);
    return ctx;
  },
});
// Register Graffiti before the router so useGraffiti() / useGraffitiSession()
// in root setup() always see the plugin.
app.use(GraffitiPlugin, {
  graffiti: resolveGraffitiImplementation(),
});
app.use(router);
try {
  app.mount("#app");
} catch (e) {
  const el = document.getElementById("app");
  if (el) {
    el.textContent =
      "App failed to mount. Open the browser console (F12) for the full error.\n" +
      String((e && e.message) || e);
  }
  throw e;
}
