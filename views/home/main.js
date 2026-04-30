import { inject } from "vue";

const CLUB_KEY = "clubChat";
const BUILD_ID = globalThis.__CLUBCHAT_BUILD_ID || String(Date.now());

export default async () => {
  const { fetchViewTemplate } = await import(
    `../../composables/fetchViewTemplate.js?v=${BUILD_ID}`
  );
  return {
    props: {
      chatId: { type: String, default: undefined },
    },
    setup() {
      return inject(CLUB_KEY);
    },
    template: await fetchViewTemplate(import.meta.url),
  };
};
