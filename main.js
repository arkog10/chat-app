import { createApp, provide } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
// import { GraffitiLocal } from "@graffiti-garden/implementation-local";
import { GraffitiPlugin } from "@graffiti-garden/wrapper-vue";

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
  graffiti: new GraffitiDecentralized(),
  // graffiti: new GraffitiLocal(),
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
