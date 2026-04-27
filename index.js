import {
  createApp,
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
// import { GraffitiLocal } from "@graffiti-garden/implementation-local";
import {
  GraffitiPlugin,
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from "@graffiti-garden/wrapper-vue";

const DISCOVERY_CHANNEL = "arkoghosh-hw10";
const LAST_SEEN_KEY = "chat-app/last-seen/v1";
const NARROW_QUERY = "(max-width: 46rem)";

/** Graffiti discover(session?: Session | null): use `null` for anonymous discovery.
 * If you pass `undefined`, @graffiti-garden/wrapper-vue substitutes `$graffitiSession`
 * (see vue.graffiti.garden docs). With `null`, only objects that have **no** `allowed`
 * property are returned — i.e. the same public directory for every viewer. */
const PUBLIC_DISCOVER_SESSION = null;

function setup() {
  const graffiti = useGraffiti();
  const session = useGraffitiSession();

  // --- View state ---
  const currentChatId = ref(null);
  const showNewChatForm = ref(false);
  const newChatTitle = ref("");
  const draftMessage = ref("");
  /** Lower sidebar: Tasks (placeholder) vs Discover (all public chats). */
  const sidebarSectionTab = ref("discover");

  // Template refs for focus management.
  const composerInputRef = ref(null);
  const newChatInputRef = ref(null);
  const messagesPanelRef = ref(null);

  // --- Busy state ---
  const createBusy = ref(false);
  const sendBusy = ref(false);
  const joinBusy = ref({});

  // --- Status banner ---
  const statusMessage = ref("");
  let statusTimer = null;
  function flashStatus(text) {
    if (statusTimer) clearTimeout(statusTimer);
    statusMessage.value = text;
    statusTimer = setTimeout(() => {
      statusMessage.value = "";
      statusTimer = null;
    }, 2200);
  }

  // --- Responsive flag ---
  const mql =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(NARROW_QUERY)
      : null;
  const isNarrow = ref(mql ? mql.matches : false);
  function onMqlChange(e) {
    isNarrow.value = e.matches;
  }
  if (mql) {
    mql.addEventListener("change", onMqlChange);
    onBeforeUnmount(() => mql.removeEventListener("change", onMqlChange));
  }

  // --- Last-seen tracking for unread counts ---
  const lastSeen = ref(loadLastSeen());
  function loadLastSeen() {
    try {
      return JSON.parse(localStorage.getItem(LAST_SEEN_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function saveLastSeen() {
    try {
      localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(lastSeen.value));
    } catch {
      /* storage might be unavailable */
    }
  }
  function markChatSeen(chatId) {
    lastSeen.value = { ...lastSeen.value, [chatId]: Date.now() };
    saveLastSeen();
  }

  /** Resolved human handles from graffiti.actorToHandle(actor), cleaned for UI */
  const handleByActor = ref({});

  // Reset transient UI on session change.
  watch(session, () => {
    currentChatId.value = null;
    showNewChatForm.value = false;
    newChatTitle.value = "";
    draftMessage.value = "";
    sidebarSectionTab.value = "discover";
    createBusy.value = false;
    sendBusy.value = false;
    joinBusy.value = {};
    handleByActor.value = {};
  });

  // --- Channels ---
  const discoveryChannel = computed(() =>
    session.value ? [DISCOVERY_CHANNEL] : [],
  );
  const joinedInboxChannel = computed(() =>
    session.value ? [session.value.actor + "/joined"] : [],
  );
  const activeChatChannel = computed(() =>
    currentChatId.value ? [currentChatId.value] : [],
  );

  // --- Discover: all public chats (same view for every user) ---
  const { objects: allChats, isFirstPoll: isAllChatsLoading } =
    useGraffitiDiscover(
      discoveryChannel,
      {
        properties: {
          value: {
            required: ["activity", "type", "title", "channel", "published"],
            properties: {
              activity: { const: "Create" },
              type: { const: "Chat" },
              title: { type: "string" },
              channel: { type: "string" },
              published: { type: "number" },
            },
          },
        },
      },
      PUBLIC_DISCOVER_SESSION,
      true,
    );

  const allChatsSorted = computed(() =>
    [...allChats.value].sort(
      (a, b) => b.value.published - a.value.published,
    ),
  );

  const chatsByChannel = computed(() => {
    const map = {};
    for (const chat of allChats.value) {
      const existing = map[chat.value.channel];
      if (!existing || existing.value.published < chat.value.published) {
        map[chat.value.channel] = chat;
      }
    }
    return map;
  });

  function chatTitle(chatId) {
    return chatsByChannel.value[chatId]?.value.title ?? "Untitled chat";
  }

  // --- Discover: this user's join records (private) ---
  const { objects: myJoins, isFirstPoll: isJoinsLoading } = useGraffitiDiscover(
    joinedInboxChannel,
    {
      properties: {
        value: {
          required: ["activity", "target", "published"],
          properties: {
            activity: { const: "Join" },
            target: { type: "string" },
            published: { type: "number" },
          },
        },
      },
    },
    session,
    true,
  );

  const joinedChatIds = computed(
    () => new Set(myJoins.value.map((j) => j.value.target)),
  );
  function hasJoined(chatId) {
    return joinedChatIds.value.has(chatId);
  }

  /** Chats not yet joined — Discover only lists these; joined chats appear under Chats. */
  const discoverUnjoinedChats = computed(() =>
    allChatsSorted.value.filter((chat) => !hasJoined(chat.value.channel)),
  );

  // --- Discover: messages across ALL my joined chats (drives unread counts) ---
  const joinedChatChannels = computed(() =>
    [...joinedChatIds.value].filter(Boolean),
  );

  const { objects: joinedMessages } = useGraffitiDiscover(
    joinedChatChannels,
    {
      properties: {
        value: {
          required: ["activity", "type", "id", "content", "published"],
          properties: {
            activity: { const: "Send" },
            type: { const: "Message" },
            id: { type: "string" },
            content: { type: "string" },
            published: { type: "number" },
          },
        },
      },
    },
    PUBLIC_DISCOVER_SESSION,
    true,
  );

  const lastMessageAt = computed(() => {
    const out = {};
    for (const m of joinedMessages.value) {
      const ch = (m.channels && m.channels[0]) || m.channel;
      if (!ch) continue;
      if (!out[ch] || out[ch] < m.value.published) {
        out[ch] = m.value.published;
      }
    }
    return out;
  });

  const myChats = computed(() => {
    const joined = joinedChatIds.value;
    return Object.values(chatsByChannel.value)
      .filter((chat) => joined.has(chat.value.channel))
      .sort((a, b) => {
        const ta =
          lastMessageAt.value[a.value.channel] ?? a.value.published;
        const tb =
          lastMessageAt.value[b.value.channel] ?? b.value.published;
        return tb - ta;
      });
  });

  function unreadCount(chatId) {
    const seen = lastSeen.value[chatId] ?? 0;
    let n = 0;
    for (const m of joinedMessages.value) {
      const ch = (m.channels && m.channels[0]) || m.channel;
      if (ch !== chatId) continue;
      if (m.actor === session.value?.actor) continue;
      if (m.value.published > seen) n += 1;
    }
    return n;
  }

  // --- Discover: messages for the currently open chat ---
  const { objects: chatMessages, isFirstPoll: areMessagesLoading } =
    useGraffitiDiscover(
      activeChatChannel,
      {
        properties: {
          value: {
            required: ["activity", "type", "id", "content", "published"],
            properties: {
              activity: { const: "Send" },
              type: { const: "Message" },
              id: { type: "string" },
              content: { type: "string" },
              published: { type: "number" },
            },
          },
        },
      },
      PUBLIC_DISCOVER_SESSION,
      true,
    );

  const sortedMessages = computed(() =>
    [...chatMessages.value].sort(
      (a, b) => a.value.published - b.value.published,
    ),
  );

  /** YYYY-MM-DD in local calendar for grouping. */
  function calendarDayKey(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Centered day chip: month name + day number only (no year). */
  function formatDayDivider(ms) {
    const d = new Date(ms);
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(d);
  }

  const messageTimeline = computed(() => {
    const items = [];
    let prevDay = null;
    for (const message of sortedMessages.value) {
      const day = calendarDayKey(message.value.published);
      if (day !== prevDay) {
        items.push({
          kind: "day",
          key: `day-${day}`,
          published: message.value.published,
          dateKey: day,
        });
        prevDay = day;
      }
      items.push({
        kind: "message",
        key: message.value.id,
        message,
      });
    }
    return items;
  });

  function cleanGraffitiHandle(raw) {
    if (raw == null || raw === "") return "";
    let s = String(raw).trim().replace(/^@/, "");
    const L = s.toLowerCase();
    if (L.endsWith(".graffiti.actor")) s = s.slice(0, -".graffiti.actor".length);
    else if (L.endsWith(".graffiti")) s = s.slice(0, -".graffiti".length);
    const segments = s.split(".").filter(Boolean);
    if (segments.length === 0) return s;
    return segments
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
      .join(" · ");
  }

  /** Tiny fallback while handle resolves or if actorToHandle fails */
  function shortDidTail(actor) {
    if (!actor) return "…";
    const parts = String(actor).split(":");
    const last = parts[parts.length - 1] || actor;
    return last.length > 12 ? `${last.slice(0, 8)}…` : last;
  }

  watch(
    [() => session.value?.actor, () => sortedMessages.value],
    async () => {
      if (!session.value) return;
      const actors = new Set();
      actors.add(session.value.actor);
      for (const m of sortedMessages.value) actors.add(m.actor);
      const pending = [...actors].filter(
        (a) => a && !handleByActor.value[a],
      );
      if (pending.length === 0) return;
      const next = { ...handleByActor.value };
      await Promise.all(
        pending.map(async (a) => {
          try {
            const raw = await graffiti.actorToHandle(a);
            next[a] = cleanGraffitiHandle(raw) || shortDidTail(a);
          } catch {
            next[a] = shortDidTail(a);
          }
        }),
      );
      handleByActor.value = next;
    },
    { immediate: true, deep: true },
  );

  const isAnyListLoading = computed(
    () => isAllChatsLoading.value || isJoinsLoading.value,
  );

  // --- Actions ---

  async function postJoin(chatId) {
    await graffiti.post(
      {
        value: { activity: "Join", target: chatId, published: Date.now() },
        allowed: [],
        channels: [session.value.actor + "/joined"],
      },
      session.value,
    );
  }

  async function onCreateChat() {
    const title = newChatTitle.value.trim();
    if (!title || createBusy.value) return;
    createBusy.value = true;
    try {
      const channel = crypto.randomUUID();
      const published = Date.now();
      await graffiti.post(
        {
          value: {
            activity: "Create",
            type: "Chat",
            title,
            channel,
            published,
          },
          // Public: omit allowed — empty allowed[] is private (creator-only).
          channels: [DISCOVERY_CHANNEL],
        },
        session.value,
      );
      // Auto-join so the creator participates in their own chat.
      await postJoin(channel);
      newChatTitle.value = "";
      showNewChatForm.value = false;
      flashStatus("Chat created.");
      openChat(channel);
    } finally {
      createBusy.value = false;
    }
  }

  async function onSelectChat(chatId) {
    if (!chatId || joinBusy.value[chatId]) return;
    // If the user hasn't joined yet, join silently so the Join action is
    // still recorded (per Part A) even though the UI just says "open".
    if (!hasJoined(chatId) && session.value) {
      joinBusy.value = { ...joinBusy.value, [chatId]: true };
      try {
        await postJoin(chatId);
      } finally {
        const next = { ...joinBusy.value };
        delete next[chatId];
        joinBusy.value = next;
      }
    }
    openChat(chatId);
  }

  async function onSendMessage() {
    const content = draftMessage.value.trim();
    if (!content || !currentChatId.value || sendBusy.value) return;
    sendBusy.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Send",
            type: "Message",
            id: crypto.randomUUID(),
            content,
            published: Date.now(),
          },
          channels: [currentChatId.value],
        },
        session.value,
      );
      draftMessage.value = "";
      markChatSeen(currentChatId.value);
    } finally {
      sendBusy.value = false;
      await nextTick();
      composerInputRef.value?.focus();
    }
  }

  function openNewChatForm() {
    showNewChatForm.value = true;
    nextTick(() => newChatInputRef.value?.focus());
  }

  function closeNewChatForm() {
    showNewChatForm.value = false;
    newChatTitle.value = "";
  }

  function scrollMessagesToBottom() {
    const el = messagesPanelRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function openChat(chatId) {
    currentChatId.value = chatId;
    markChatSeen(chatId);
    nextTick(() => {
      requestAnimationFrame(() => {
        scrollMessagesToBottom();
        composerInputRef.value?.focus();
      });
    });
  }

  function closeChat() {
    if (currentChatId.value) markChatSeen(currentChatId.value);
    currentChatId.value = null;
  }

  // Keep last-seen fresh while viewing the chat.
  watch(
    [() => currentChatId.value, () => chatMessages.value?.length],
    () => {
      if (currentChatId.value) markChatSeen(currentChatId.value);
    },
  );

  // Opened chat should show the latest messages (scroll to end).
  watch(
    [
      currentChatId,
      () => sortedMessages.value.length,
      () => sortedMessages.value.at(-1)?.value.published,
    ],
    async () => {
      if (!currentChatId.value) return;
      await nextTick();
      requestAnimationFrame(() => scrollMessagesToBottom());
    },
  );

  // --- Formatting helpers ---

  /** Time only (date lives in the day divider above). */
  function formatMessageTime(ms) {
    const d = new Date(ms);
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  }

  function displayActor(actor) {
    if (!actor) return "Anonymous";
    if (session.value && actor === session.value.actor) return "You";
    const tail = actor.split(":").pop() ?? actor;
    return tail.length > 10 ? tail.slice(-6) : tail;
  }

  /**
   * Human-readable name (nav + message pills): Graffiti `actorToHandle`, cached in
   * `handleByActor`. Never parse DIDs — that produced garbage like random id segments.
   */
  function graffitiDisplayName(actor) {
    if (!actor) return "Someone";
    const hit = handleByActor.value[actor];
    if (hit) return hit;
    return shortDidTail(actor);
  }

  /** Stable hue for peer avatar ring / label accent (from actor string). */
  function peerAccentHue(actor) {
    if (!actor) return 158;
    let h = 0;
    for (let i = 0; i < actor.length; i++)
      h = (h + actor.charCodeAt(i) * 17) % 360;
    return h;
  }

  return {
    // state
    currentChatId,
    showNewChatForm,
    newChatTitle,
    draftMessage,
    sidebarSectionTab,
    createBusy,
    sendBusy,
    joinBusy,
    statusMessage,
    isNarrow,
    composerInputRef,
    newChatInputRef,
    messagesPanelRef,
    // data
    allChatsSorted,
    discoverUnjoinedChats,
    myChats,
    sortedMessages,
    messageTimeline,
    // loading
    isAllChatsLoading,
    isAnyListLoading,
    areMessagesLoading,
    // actions
    onCreateChat,
    onSelectChat,
    onSendMessage,
    openNewChatForm,
    closeNewChatForm,
    openChat,
    closeChat,
    // helpers
    hasJoined,
    chatTitle,
    unreadCount,
    formatMessageTime,
    formatDayDivider,
    displayActor,
    graffitiDisplayName,
    peerAccentHue,
  };
}

createApp({ template: "#template", setup })
  .use(GraffitiPlugin, {
    graffiti: new GraffitiDecentralized(),
    // Offline / single-browser only:
    // graffiti: new GraffitiLocal(),
  })
  .mount("#app");
