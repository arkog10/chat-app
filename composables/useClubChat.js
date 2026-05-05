import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from "@graffiti-garden/wrapper-vue";
import {
  forgetTaskDetail,
  loadTaskFieldMap,
  mergeTaskFieldsFromStorage,
  normalizeAssigneesInput,
  rememberTaskDetail,
  saveTaskFieldMap,
} from "./taskFieldStorage.js?v=task-row-20260429-3";

const DISCOVERY_CHANNEL = "arkoghosh-hw10";
const LAST_SEEN_KEY = "chat-app/last-seen/v1";
const PROFILE_KEY_PREFIX = "chat-app/user-profile/v1";

const NARROW_QUERY = "(max-width: 46rem)";
export const MAX_GROUP_NAME_LEN = 50;

export const TASK_DOC_TYPE = "ClubChatTaskV1";
export const PROFILE_DOC_TYPE = "ClubChatProfileV1";
/** Max serialized photo length posted to the network (others load your pfp from here). */
const MAX_PROFILE_NETWORK_CHARS = 380000;

/** Profile picture presets (`avatarKey`). Color-coded group tags below. */
export const AVATAR_PRESETS = [
  { id: "fern", emoji: "🌿" },
  { id: "ocean", emoji: "🌊" },
  { id: "spark", emoji: "✨" },
  { id: "moon", emoji: "🌙" },
  { id: "bolt", emoji: "⚡" },
  { id: "leaf", emoji: "🍃" },
  { id: "star", emoji: "⭐️" },
  { id: "coffee", emoji: "☕️" },
];

export const GROUP_TAG_OPTIONS = [
  { id: "club", label: "Club" },
  { id: "lab", label: "Lab" },
  { id: "sports", label: "Sports" },
  { id: "class", label: "Class" },
  { id: "dorm", label: "Dorm" },
  { id: "study", label: "Study" },
  { id: "social", label: "Social" },
  { id: "hobby", label: "Hobby" },
  { id: "other", label: "Other" },
];

/** Graffiti discover(session?: Session | null): use `null` for anonymous discovery.
 * If you pass `undefined`, @graffiti-garden/wrapper-vue substitutes `$graffitiSession`
 * (see vue.graffiti.garden docs). With `null`, only objects that have **no** `allowed`
 * property are returned — i.e. the same public directory for every viewer. */
const PUBLIC_DISCOVER_SESSION = null;

/** Normalize channel id for joins, inbox matching, and routes (trim / stringify). */
export function joinChatChannelKey(chatId) {
  if (chatId == null || chatId === "") return "";
  return String(chatId).trim();
}

export const CLUB_KEY = "clubChat";

export function useClubChat() {
  const route = useRoute();
  const router = useRouter();
  const graffiti = useGraffiti();
  const session = useGraffitiSession();

  // --- View state ---
  const currentChatId = ref(null);
  const newChatTitle = ref("");
  const newChatDescription = ref("");
  const newGroupType = ref("class");
  const draftMessage = ref("");
  const chatInfoOpen = ref(false);
  const chatActionMenuOpen = ref(false);
  const leaveOrDeleteBusy = ref(false);
  /** Local profile pic: key into `AVATAR_PRESETS` */
  const selfProfile = ref({
    displayName: "",
    classYear: "",
    major: "",
    bio: "",
    avatarKey: "fern",
    avatarPhotoDataUrl: "",
  });
  const profileEditing = ref(false);
  const profileDraft = ref({
    displayName: "",
    classYear: "",
    major: "",
    bio: "",
    avatarKey: "fern",
    avatarPhotoDataUrl: "",
  });

  /** Explore: which channel’s details are open (null = closed) */
  const exploreInfoChannel = ref(null);

  /** `'messages'` | `'tasks'` — main pane when a chat is open */
  const mainPaneTab = ref("messages");
  /** `'chats'` | `'tasks'` — left rail on home */
  const sidebarPaneTab = ref("chats");
  const suppressMainPaneReset = ref(false);
  const chatTaskCreateOpen = ref(false);
  const taskEditingId = ref(null);
  /** Middle-pane task row showing description / assignees. */
  const taskExpandedId = ref(/** @type {string | null} */ (null));
  /** Which task’s ⋮ menu is open (synced with teleport position). */
  const taskMenuOpenForTaskId = ref(null);
  /** `{ top, left }` in px for fixed task dropdown under Teleport */
  const taskMenuFixedPosition = ref(null);
  /** Exact row object for the ⋮ menu (Teleport avoids lookup races). */
  const kebabMenuTask = ref(/** @type {Record<string, unknown> | null} */ (null));
  const chatMetaEditing = ref(false);
  const chatMetaDraft = ref({
    title: "",
    description: "",
    groupType: "class",
  });
  const chatMetaBusy = ref(false);
  /** Latest Create per channel applied immediately after save until discover catches up. */
  const localChatCreateBump = ref({});

  const taskDraft = ref({
    title: "",
    deadlineLocal: "",
    completed: false,
    description: "",
    /** Graffiti actor strings — subset of current chat members */
    assigneeActors: /** @type {string[]} */ ([]),
  });
  const taskBusy = ref(false);
  const taskCompleteBusy = ref(/** @type {Record<string, boolean>} */ ({}));
  const sidebarTaskFilter = ref("all");
  const chatTaskFilter = ref("all");

  /**
   * description + assignees by channel id, then taskId — backup when Graffiti discover
   * returns UpsertTask without those fields hydrated.
   */
  const taskFieldsCache = ref({});
  /** Mirrors local save into the task card until Graffiti echoes assignees like description. */
  const savedTaskHydrationById = ref(
    /** @type {Record<string, { assignees: string[]; description?: string }>} */ ({}),
  );
  /**
   * Complete task events written by this client during the current session.
   * Graffiti discover is asynchronous, so these rows let task cards render the
   * full title/description/due date/assignees payload immediately after save.
   */
  const localTaskUpsertObjects = ref([]);
  const localTaskDeleteObjects = ref([]);

  // Template refs for focus management.
  const composerInputRef = ref(null);
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
    const id = joinChatChannelKey(chatId);
    if (!id) return;
    lastSeen.value = { ...lastSeen.value, [id]: Date.now() };
    saveLastSeen();
  }

  /** Resolved human handles from graffiti.actorToHandle(actor), cleaned for UI */
  const handleByActor = ref({});

  function loadUserProfile() {
    if (!session.value) {
      selfProfile.value = {
        displayName: "",
        classYear: "",
        major: "",
        bio: "",
        avatarKey: "fern",
        avatarPhotoDataUrl: "",
      };
      return;
    }
    try {
      const raw = localStorage.getItem(
        `${PROFILE_KEY_PREFIX}/${session.value.actor}`,
      );
      const parsed = raw ? JSON.parse(raw) : null;
      selfProfile.value = parsed
        ? {
            displayName: "",
            classYear: "",
            major: "",
            bio: "",
            avatarKey: "fern",
            avatarPhotoDataUrl: "",
            ...parsed,
          }
        : {
            displayName: "",
            classYear: "",
            major: "",
            bio: "",
            avatarKey: "fern",
            avatarPhotoDataUrl: "",
          };
    } catch {
      selfProfile.value = {
        displayName: "",
        classYear: "",
        major: "",
        bio: "",
        avatarKey: "fern",
        avatarPhotoDataUrl: "",
      };
    }
  }

  loadUserProfile();

  // Reset transient UI on session change.
  watch(session, () => {
    const a = session.value?.actor;
    taskFieldsCache.value = a ? loadTaskFieldMap(a) : {};
    currentChatId.value = null;
    newChatTitle.value = "";
    newChatDescription.value = "";
    newGroupType.value = "class";
    draftMessage.value = "";
    createBusy.value = false;
    sendBusy.value = false;
    joinBusy.value = {};
    taskCompleteBusy.value = {};
    sidebarTaskFilter.value = "all";
    chatTaskFilter.value = "all";
    handleByActor.value = {};
    chatInfoOpen.value = false;
    chatActionMenuOpen.value = false;
    exploreInfoChannel.value = null;
    mainPaneTab.value = "messages";
    chatTaskCreateOpen.value = false;
    taskEditingId.value = null;
    taskExpandedId.value = null;
    taskMenuOpenForTaskId.value = null;
    taskMenuFixedPosition.value = null;
    kebabMenuTask.value = null;
    savedTaskHydrationById.value = {};
    localTaskUpsertObjects.value = [];
    localTaskDeleteObjects.value = [];
    chatMetaEditing.value = false;
    profileEditing.value = false;
    loadUserProfile();
    if (router.currentRoute.value.name !== "home") {
      void router.push({ name: "home" });
    }
  });

  // --- Channels ---
  const discoveryChannel = computed(() =>
    session.value ? [DISCOVERY_CHANNEL] : [],
  );
  const joinedInboxChannel = computed(() =>
    session.value ? [session.value.actor + "/joined"] : [],
  );
  const activeChatChannel = computed(() => {
    const id = joinChatChannelKey(currentChatId.value);
    return id ? [id] : [];
  });

  // --- Discover: all public Create + tombstone Deletes ---
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
              description: { type: "string" },
              groupType: { type: "string" },
            },
          },
        },
      },
      PUBLIC_DISCOVER_SESSION,
      true,
    );

  const { objects: deleteChats, isFirstPoll: isDeletesLoading } =
    useGraffitiDiscover(
      discoveryChannel,
      {
        properties: {
          value: {
            required: ["activity", "type", "channel", "published"],
            properties: {
              activity: { const: "Delete" },
              type: { const: "Chat" },
              channel: { type: "string" },
              published: { type: "number" },
            },
          },
        },
      },
      PUBLIC_DISCOVER_SESSION,
      true,
    );

  const { objects: profileUpsertObjects } = useGraffitiDiscover(
    discoveryChannel,
    {
      properties: {
        value: {
          required: ["activity", "type", "published"],
          properties: {
            activity: { const: "UpsertProfile" },
            type: { const: PROFILE_DOC_TYPE },
            published: { type: "number" },
            displayName: { type: "string" },
            avatarKey: { type: "string" },
            avatarPhotoDataUrl: { type: "string" },
          },
        },
      },
    },
    PUBLIC_DISCOVER_SESSION,
    true,
  );

  const remoteProfileByActor = computed(() => {
    const sorted = [...profileUpsertObjects.value].sort(
      (a, b) => a.value.published - b.value.published,
    );
    const out = {};
    for (const o of sorted) {
      if (o.value?.activity !== "UpsertProfile") continue;
      out[o.actor] = {
        displayName: String(o.value.displayName || "").trim(),
        avatarKey: String(o.value.avatarKey || "fern"),
        avatarPhotoDataUrl: String(o.value.avatarPhotoDataUrl || ""),
      };
    }
    return out;
  });

  watch(
    () => remoteProfileByActor.value,
    (remote) => {
      const next = { ...handleByActor.value };
      let changed = false;
      for (const [actor, p] of Object.entries(remote)) {
        const name = p?.displayName?.trim();
        if (!actor || !name) continue;
        if (next[actor] !== name) {
          next[actor] = name;
          changed = true;
        }
      }
      if (changed) handleByActor.value = next;
    },
    { deep: true },
  );

  const lastDeleteTimeByChannel = computed(() => {
    const m = new Map();
    for (const o of deleteChats.value) {
      const ch = joinChatChannelKey(o.value.channel);
      if (!ch) continue;
      const p = o.value.published;
      if (!m.has(ch) || p > m.get(ch)) m.set(ch, p);
    }
    return m;
  });

  function createIsTombstoned(c) {
    const tCreate = c.value.published;
    const ch = joinChatChannelKey(c.value.channel);
    if (!ch) return false;
    const tDel = lastDeleteTimeByChannel.value.get(ch) ?? 0;
    return tCreate <= tDel;
  }

  function mergeLatestChatCreates(chatObjects) {
    const map = {};
    for (const chat of chatObjects) {
      if (createIsTombstoned(chat)) continue;
      const ch = joinChatChannelKey(chat.value.channel);
      if (!ch) continue;
      const existing = map[ch];
      if (!existing || existing.value.published < chat.value.published) {
        map[ch] = chat;
      }
    }
    return map;
  }

  const allChatsSorted = computed(() =>
    [...allChats.value]
      .filter((c) => !createIsTombstoned(c))
      .sort((a, b) => b.value.published - a.value.published),
  );

  const chatsByChannel = computed(() => {
    const map = mergeLatestChatCreates(allChats.value);
    for (const [ch, bump] of Object.entries(localChatCreateBump.value)) {
      const key = joinChatChannelKey(ch);
      if (!key) continue;
      const cur = map[key];
      if (!cur || cur.value.published < bump.value.published) {
        map[key] = bump;
      }
    }
    return map;
  });

  const exploreInfoChat = computed(() => {
    const id = joinChatChannelKey(exploreInfoChannel.value);
    if (!id) return null;
    return chatsByChannel.value[id] ?? null;
  });

  const explorePublicChatCount = computed(
    () => Object.keys(chatsByChannel.value).length,
  );

  watch(
    allChats,
    () => {
      const bumps = localChatCreateBump.value;
      const keys = Object.keys(bumps);
      if (!keys.length) return;
      const remote = mergeLatestChatCreates(allChats.value);
      const next = { ...bumps };
      let changed = false;
      for (const ch of keys) {
        const key = joinChatChannelKey(ch);
        const r = remote[key];
        const b = next[ch];
        if (!key || !b) continue;
        if (r && r.value.published >= b.value.published) {
          delete next[ch];
          changed = true;
        }
      }
      if (changed) localChatCreateBump.value = next;
    },
    { deep: true },
  );

  function chatTitle(chatId) {
    const id = joinChatChannelKey(chatId);
    return chatsByChannel.value[id]?.value.title ?? "Untitled chat";
  }

  function chatDescriptionText(chatId) {
    const id = joinChatChannelKey(chatId);
    return chatsByChannel.value[id]?.value?.description?.trim() ?? "";
  }

  function chatGroupType(chatId) {
    const id = joinChatChannelKey(chatId);
    return chatsByChannel.value[id]?.value?.groupType?.trim() ?? "class";
  }

  function isChatOwner(chatId) {
    if (!session.value) return false;
    const id = joinChatChannelKey(chatId);
    const c = chatsByChannel.value[id];
    return c?.actor === session.value.actor;
  }

  // --- Inbox: Join and Leave (private) ---
  const { objects: inboxIn, isFirstPoll: isInboxLoading } = useGraffitiDiscover(
    joinedInboxChannel,
    {
      properties: {
        value: {
          required: ["activity", "target", "published"],
          properties: {
            activity: { type: "string" },
            target: { type: "string" },
            published: { type: "number" },
          },
        },
      },
    },
    session,
    true,
  );

  const inboxSignups = computed(() =>
    inboxIn.value.filter(
      (o) => o.value.activity === "Join" || o.value.activity === "Leave",
    ),
  );

  function isJoinedToTarget(target) {
    const t = joinChatChannelKey(target);
    if (!t) return false;
    const evs = inboxSignups.value
      .filter((o) => joinChatChannelKey(o.value.target) === t)
      .map((o) => o.value)
      .sort((a, b) => a.published - b.published);
    if (evs.length === 0) return false;
    return evs[evs.length - 1].activity === "Join";
  }

  const joinedChatIds = computed(() => {
    const targets = new Set(
      inboxSignups.value
        .map((o) => joinChatChannelKey(o.value.target))
        .filter(Boolean),
    );
    const s = new Set();
    for (const t of targets) {
      if (isJoinedToTarget(t)) s.add(t);
    }
    return s;
  });
  /** Membership comes from the private inbox only (not whether Create docs are loaded). */
  function hasJoined(chatId) {
    return isJoinedToTarget(chatId);
  }

  const discoverUnjoinedChats = computed(() =>
    Object.values(chatsByChannel.value)
      .filter((chat) => !isJoinedToTarget(chat.value.channel))
      .sort((a, b) => b.value.published - a.value.published),
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
      const ch = joinChatChannelKey(
        (m.channels && m.channels[0]) || m.channel,
      );
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
      .filter((chat) =>
        joined.has(joinChatChannelKey(chat.value.channel)),
      )
      .sort((a, b) => {
        const ta =
          lastMessageAt.value[joinChatChannelKey(a.value.channel)] ??
          a.value.published;
        const tb =
          lastMessageAt.value[joinChatChannelKey(b.value.channel)] ??
          b.value.published;
        return tb - ta;
      });
  });

  function unreadCount(chatId) {
    const id = joinChatChannelKey(chatId);
    const seen = lastSeen.value[id] ?? 0;
    let n = 0;
    for (const m of joinedMessages.value) {
      const ch = joinChatChannelKey(
        (m.channels && m.channels[0]) || m.channel,
      );
      if (ch !== id) continue;
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

  const { objects: rosterInChat, isFirstPoll: isRosterLoading } =
    useGraffitiDiscover(
      activeChatChannel,
      {
        properties: {
          value: {
            required: ["activity", "type", "member", "published"],
            properties: {
              activity: { const: "Roster" },
              type: { type: "string" },
              member: { type: "string" },
              published: { type: "number" },
            },
          },
        },
      },
      PUBLIC_DISCOVER_SESSION,
      true,
    );

  const chatRosterByMember = computed(() => {
    const last = new Map();
    const list = [...rosterInChat.value]
      .map((o) => o.value)
      .sort((a, b) => a.published - b.published);
    for (const v of list) {
      if (v.activity !== "Roster" || v.type == null) continue;
      if (v.type === "Here") {
        last.set(v.member, true);
      } else if (v.type === "Gone") {
        last.set(v.member, false);
      }
    }
    return last;
  });

  const currentChatMemberActors = computed(() => {
    const s = new Set();
    for (const [m, h] of chatRosterByMember.value) {
      if (h) s.add(m);
    }
    if (session.value) {
      s.add(session.value.actor);
    }
    for (const m of sortedMessages.value) s.add(m.actor);
    if (currentChatId.value) {
      const cid = joinChatChannelKey(currentChatId.value);
      const c = cid ? chatsByChannel.value[cid] : undefined;
      if (c?.actor) s.add(c.actor);
    }
    return [...s].filter(Boolean).sort();
  });

  const exploreInfoDetailChannels = computed(() => {
    const id = joinChatChannelKey(exploreInfoChannel.value);
    return id ? [id] : [];
  });

  const { objects: explorePreviewMessages } = useGraffitiDiscover(
    exploreInfoDetailChannels,
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

  const { objects: explorePreviewRoster } = useGraffitiDiscover(
    exploreInfoDetailChannels,
    {
      properties: {
        value: {
          required: ["activity", "type", "member", "published"],
          properties: {
            activity: { const: "Roster" },
            type: { type: "string" },
            member: { type: "string" },
            published: { type: "number" },
          },
        },
      },
    },
    PUBLIC_DISCOVER_SESSION,
    true,
  );

  const explorePreviewRosterByMember = computed(() => {
    const last = new Map();
    const list = [...explorePreviewRoster.value]
      .map((o) => o.value)
      .sort((a, b) => a.published - b.published);
    for (const v of list) {
      if (v.activity !== "Roster" || v.type == null) continue;
      if (v.type === "Here") {
        last.set(v.member, true);
      } else if (v.type === "Gone") {
        last.set(v.member, false);
      }
    }
    return last;
  });

  /** Members visible from public roster + messages (Explore info modal). */
  const explorePreviewMemberActors = computed(() => {
    const chat = exploreInfoChat.value;
    if (!chat) return [];
    const ch = joinChatChannelKey(chat.value.channel);
    if (!ch) return [];
    const s = new Set();
    for (const [m, here] of explorePreviewRosterByMember.value) {
      if (here) s.add(m);
    }
    for (const o of explorePreviewMessages.value) {
      const och = joinChatChannelKey(
        (o.channels && o.channels[0]) || o.channel,
      );
      if (och !== ch) continue;
      if (o.actor) s.add(o.actor);
    }
    return [...s].filter(Boolean).sort((a, b) =>
      String(a).localeCompare(String(b)),
    );
  });

  const { objects: joinedTaskUpsertObjects } = useGraffitiDiscover(
    joinedChatChannels,
    {
      properties: {
        value: {
          required: [
            "activity",
            "type",
            "taskId",
            "title",
            "description",
            "deadline",
            "assignees",
            "completed",
            "published",
          ],
          properties: {
            activity: { const: "UpsertTask" },
            type: { const: TASK_DOC_TYPE },
            taskId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            deadline: { type: "number" },
            assignees: {
              type: "array",
              items: { type: "string" },
            },
            completed: { type: "boolean" },
            published: { type: "number" },
          },
        },
      },
    },
    PUBLIC_DISCOVER_SESSION,
    true,
  );

  const { objects: joinedTaskDeleteObjects } = useGraffitiDiscover(
    joinedChatChannels,
    {
      properties: {
        value: {
          required: ["activity", "type", "taskId", "published"],
          properties: {
            activity: { const: "DeleteTask" },
            type: { const: TASK_DOC_TYPE },
            taskId: { type: "string" },
            published: { type: "number" },
          },
        },
      },
    },
    PUBLIC_DISCOVER_SESSION,
    true,
  );

  // ---------------------------------------------------------------------------
  // Tasks — fold Upserts/Deletes + optional persisted description/assignees
  // (composables/taskFieldStorage.js counters sparse Graffiti discover rows)
  // ---------------------------------------------------------------------------

  function channelFromObject(o) {
    return (o.channels && o.channels[0]) || o.channel || "";
  }

  function mergeTaskUpsertsDeletes(upsRaw, delsRaw) {
    const upsSorted = [...upsRaw].sort(
      (a, b) => a.value.published - b.value.published,
    );
    /**
     * Fold all UpsertTask events for a task in time order. A newer upsert
     * (e.g. toggling `completed` only) must not wipe fields that were
     * omitted in that document — the previous merge only kept the *last* row,
     * which could drop title/deadline/description/assignees.
     */
    const foldedByTaskId = new Map();
    for (const o of upsSorted) {
      const v = o.value;
      const taskId = v.taskId;
      const prev = foldedByTaskId.get(taskId);
      if (!prev) {
        foldedByTaskId.set(taskId, {
          taskId,
          title: "title" in v ? (v.title == null ? "" : String(v.title)) : "",
          description: "description" in v
            ? v.description == null
              ? ""
              : String(v.description)
            : "",
          deadline: "deadline" in v ? v.deadline : undefined,
          assignees: "assignees" in v
            ? normalizeAssigneesInput(v.assignees)
            : [],
          published: v.published,
          creatorActor: o.actor || "",
          completed: "completed" in v && (v.completed === true || v.completed === 1),
        });
        continue;
      }
      const n = {
        ...prev,
        published: v.published,
        creatorActor: o.actor || prev.creatorActor || "",
      };
      if ("title" in v) n.title = v.title == null ? "" : String(v.title);
      if ("description" in v) {
        n.description = v.description == null ? "" : String(v.description);
      }
      if ("deadline" in v) n.deadline = v.deadline;
      if ("assignees" in v) {
        n.assignees = normalizeAssigneesInput(v.assignees);
      }
      if ("completed" in v) n.completed = v.completed === true || v.completed === 1;
      foldedByTaskId.set(taskId, n);
    }
    const deleteAt = new Map();
    for (const o of delsRaw) {
      const id = o.value.taskId;
      const p = o.value.published;
      if (!deleteAt.has(id) || p > deleteAt.get(id)) deleteAt.set(id, p);
    }
    const out = [];
    for (const [taskId, t] of foldedByTaskId) {
      const dup = deleteAt.get(taskId) ?? 0;
      if (dup > t.published) continue;
      out.push({
        taskId,
        title: t.title,
        description: t.description,
        deadline: t.deadline,
        assignees: t.assignees,
        published: t.published,
        creatorActor: t.creatorActor,
        completed: t.completed,
      });
    }
    out.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.deadline !== b.deadline) return a.deadline - b.deadline;
      return String(a.title).localeCompare(String(b.title));
    });
    return out;
  }

  function persistTaskFieldsSnapshot() {
    const actor = session.value?.actor;
    saveTaskFieldMap(actor, taskFieldsCache.value);
  }

  /** Prefer discover + fall back to localStorage merge (see ./taskFieldStorage.js). */
  function mergeDiscoveredTaskWithCache(task, channelKey) {
    return mergeTaskFieldsFromStorage(task, channelKey, taskFieldsCache.value);
  }

  function rememberTaskFields(channelKey, taskId, patch) {
    if (!channelKey || !taskId) return;
    taskFieldsCache.value = rememberTaskDetail(
      taskFieldsCache.value,
      channelKey,
      taskId,
      patch,
    );
    persistTaskFieldsSnapshot();
  }

  function forgetTaskFields(channelKey, taskId) {
    taskFieldsCache.value = forgetTaskDetail(
      taskFieldsCache.value,
      channelKey,
      taskId,
    );
    persistTaskFieldsSnapshot();
  }

  function rememberLocalTaskUpsert(channelKey, value, actor) {
    const ch = joinChatChannelKey(channelKey);
    if (!ch || !value?.taskId) return;
    localTaskUpsertObjects.value = [
      ...localTaskUpsertObjects.value,
      {
        actor: actor || session.value?.actor || "",
        channels: [ch],
        channel: ch,
        value: {
          ...value,
          assignees: normalizeAssigneesInput(value.assignees),
        },
      },
    ];
  }

  function rememberLocalTaskDelete(channelKey, value, actor) {
    const ch = joinChatChannelKey(channelKey);
    if (!ch || !value?.taskId) return;
    localTaskDeleteObjects.value = [
      ...localTaskDeleteObjects.value,
      {
        actor: actor || session.value?.actor || "",
        channels: [ch],
        channel: ch,
        value: { ...value },
      },
    ];
  }

  /** Creator is always persisted on assignees; visibility = effective assignees includes viewer. */
  function taskEffectiveAssignees(task) {
    const cr = String(task?.creatorActor || "").trim();
    return normalizeAssigneesInput([
      ...(cr ? [cr] : []),
      ...normalizeAssigneesInput(task?.assignees),
    ]);
  }

  function taskVisibleToSession(task) {
    if (!session.value?.actor || !task?.taskId) return false;
    return taskEffectiveAssignees(task).includes(session.value.actor);
  }

  const allJoinedTasksList = computed(() => {
    const byCh = new Map();
    const joined = joinedChatIds.value;
    const taskUpserts = [
      ...joinedTaskUpsertObjects.value,
      ...localTaskUpsertObjects.value.filter((o) =>
        joined.has(joinChatChannelKey(channelFromObject(o))),
      ),
    ];
    const taskDeletes = [
      ...joinedTaskDeleteObjects.value,
      ...localTaskDeleteObjects.value.filter((o) =>
        joined.has(joinChatChannelKey(channelFromObject(o))),
      ),
    ];
    for (const o of taskUpserts) {
      const ch = channelFromObject(o);
      if (!ch) continue;
      if (!byCh.has(ch)) byCh.set(ch, { ups: [], dels: [] });
      byCh.get(ch).ups.push(o);
    }
    for (const o of taskDeletes) {
      const ch = channelFromObject(o);
      if (!ch) continue;
      if (!byCh.has(ch)) byCh.set(ch, { ups: [], dels: [] });
      byCh.get(ch).dels.push(o);
    }
    const rows = [];
    for (const [chatId, { ups, dels }] of byCh) {
      const chNorm = joinChatChannelKey(chatId);
      const folded = mergeTaskUpsertsDeletes(ups, dels).map((t) =>
        mergeDiscoveredTaskWithCache(t, chNorm),
      );
      const merged = folded.filter(taskVisibleToSession);
      for (const t of merged) rows.push({ ...t, chatId: chNorm });
    }
    rows.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.deadline !== b.deadline) return a.deadline - b.deadline;
      return String(a.title).localeCompare(String(b.title));
    });
    return rows;
  });

  /**
   * Main pane: use the same joined-channel task index as the sidebar, scoped
   * to the open chat. The per-active-channel discover stream can return
   * objects that lose title/description when the latest row is a completion
   * patch; the joined index matches what the left rail already shows.
   */
  const chatTasksVisible = computed(() => {
    const ch = joinChatChannelKey(currentChatId.value);
    if (!ch) return [];
    return allJoinedTasksList.value.filter(
      (t) => joinChatChannelKey(t.chatId) === ch,
    );
  });

  function taskMatchesSidebarFilter(task) {
    const f = sidebarTaskFilter.value;
    if (f === "pending") return !task.completed;
    if (f === "complete") return task.completed;
    return true;
  }

  function taskMatchesChatFilter(task) {
    const f = chatTaskFilter.value;
    if (f === "pending") return !task.completed;
    if (f === "complete") return task.completed;
    return true;
  }

  const sidebarJoinedTasksFiltered = computed(() =>
    allJoinedTasksList.value.filter(taskMatchesSidebarFilter),
  );

  const chatTasksFiltered = computed(() =>
    chatTasksVisible.value.filter(taskMatchesChatFilter),
  );

  const chatTaskRowsForDisplay = computed(() =>
    chatTasksFiltered.value.map((task, index) => {
      const taskId =
        task?.taskId == null || task.taskId === ""
          ? `missing-task-${index}`
          : String(task.taskId);
      const title = String(task?.title || "").trim() || "Untitled task";
      const deadline = task?.deadline;
      const detailDescription = String(task?.description ?? "").trim();
      const creatorActor = String(task?.creatorActor || "").trim();
      const detailAssigneesDisplay = normalizeAssigneesInput([
        ...(creatorActor ? [creatorActor] : []),
        ...normalizeAssigneesInput(task?.assignees),
      ]);
      const hasTaskDetails =
        Boolean(detailDescription) || detailAssigneesDisplay.length > 0;
      return {
        ...task,
        taskId,
        displayTitle: title,
        displayDeadline: formatTaskDeadline(deadline),
        displayKey: `${taskId}:${task?.published || index}`,
        detailDescription,
        detailAssigneesDisplay,
        hasTaskDetails,
        isOverdue:
          !task?.completed &&
          deadline != null &&
          deadline !== "" &&
          Number(deadline) < Date.now(),
      };
    }),
  );

  function taskToggleBusyKey(chatId, taskId) {
    return `${joinChatChannelKey(chatId)}:${taskId}`;
  }

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
    [
      () => session.value?.actor,
      () => sortedMessages.value,
      () => currentChatMemberActors.value,
      () => selfProfile.value?.displayName,
    ],
    async () => {
      if (!session.value) return;
      const actors = new Set();
      actors.add(session.value.actor);
      for (const m of sortedMessages.value) actors.add(m.actor);
      for (const a of currentChatMemberActors.value) actors.add(a);
      if (selfProfile.value?.displayName?.trim() && session.value) {
        handleByActor.value = {
          ...handleByActor.value,
          [session.value.actor]: selfProfile.value.displayName.trim(),
        };
      }
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
    () =>
      isAllChatsLoading.value ||
      isInboxLoading.value ||
      isDeletesLoading.value,
  );

  // --- Actions ---

  async function postRosterHere(chatId) {
    const ch = joinChatChannelKey(chatId);
    if (!session.value || !ch) return;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Roster",
            type: "Here",
            member: session.value.actor,
            published: Date.now(),
          },
          channels: [ch],
        },
        session.value,
      );
    } catch {
      /* best-effort */
    }
  }

  async function postRosterGone(chatId) {
    const ch = joinChatChannelKey(chatId);
    if (!session.value || !ch) return;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Roster",
            type: "Gone",
            member: session.value.actor,
            published: Date.now(),
          },
          channels: [ch],
        },
        session.value,
      );
    } catch {
      /* best-effort */
    }
  }

  async function postJoin(chatId) {
    const target = joinChatChannelKey(chatId);
    if (!target || !session.value) {
      throw new Error("Missing channel or session for join.");
    }
    await graffiti.post(
      {
        value: { activity: "Join", target, published: Date.now() },
        allowed: [],
        channels: [session.value.actor + "/joined"],
      },
      session.value,
    );
    await postRosterHere(target);
  }

  async function postLeaveInbox(chatId) {
    const target = joinChatChannelKey(chatId);
    if (!target || !session.value) {
      throw new Error("Missing channel or session for leave.");
    }
    await graffiti.post(
      {
        value: { activity: "Leave", target, published: Date.now() },
        allowed: [],
        channels: [session.value.actor + "/joined"],
      },
      session.value,
    );
  }

  async function onCreateChat() {
    const title = newChatTitle.value.trim();
    if (!title || createBusy.value) return;
    if (title.length > MAX_GROUP_NAME_LEN) {
      flashStatus(`Name must be ${MAX_GROUP_NAME_LEN} characters or fewer.`);
      return;
    }
    const desc = newChatDescription.value.trim();
    if (!desc) {
      flashStatus("Add a short description for the group.");
      return;
    }
    const gt = (newGroupType.value || "class").trim() || "class";
    createBusy.value = true;
    try {
      const channel = crypto.randomUUID();
      const published = Date.now();
      const value = {
        activity: "Create",
        type: "Chat",
        title,
        channel,
        published,
        groupType: gt,
        description: desc.slice(0, 2000),
      };
      await graffiti.post(
        {
          value,
          channels: [DISCOVERY_CHANNEL],
        },
        session.value,
      );
      await postJoin(channel);
      newChatTitle.value = "";
      newChatDescription.value = "";
      newGroupType.value = "class";
      flashStatus("Chat created.");
      void router.push({ name: "chat", params: { chatId: channel } });
    } finally {
      createBusy.value = false;
    }
  }

  async function onLeaveGroup(chatId) {
    if (!session.value || leaveOrDeleteBusy.value) return;
    if (!hasJoined(chatId)) return;
    if (
      !window.confirm("Leave this group? You can re-join from Explore if it is public.")
    ) {
      return;
    }
    leaveOrDeleteBusy.value = true;
    try {
      await postLeaveInbox(chatId);
      await postRosterGone(chatId);
      chatActionMenuOpen.value = false;
      flashStatus("You left the group.");
      const leftCh = joinChatChannelKey(chatId);
      if (joinChatChannelKey(exploreInfoChannel.value) === leftCh) {
        exploreInfoChannel.value = null;
      }
      if (joinChatChannelKey(currentChatId.value) === leftCh) {
        void router.push({ name: "home" });
      }
    } catch {
      flashStatus("Could not leave the group. Try again.");
    } finally {
      leaveOrDeleteBusy.value = false;
    }
  }

  async function onDeleteGroup(chatId) {
    if (!session.value || leaveOrDeleteBusy.value) return;
    if (
      !window.confirm(
        "Permanently delete this group for everyone? This cannot be undone.",
      )
    ) {
      return;
    }
    leaveOrDeleteBusy.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Delete",
            type: "Chat",
            channel: joinChatChannelKey(chatId),
            published: Date.now(),
          },
          channels: [DISCOVERY_CHANNEL],
        },
        session.value,
      );
      await postRosterGone(chatId);
      void postLeaveInbox(chatId).catch(() => {});
      chatActionMenuOpen.value = false;
      flashStatus("Group deleted.");
      const delCh = joinChatChannelKey(chatId);
      if (joinChatChannelKey(exploreInfoChannel.value) === delCh) {
        exploreInfoChannel.value = null;
      }
      if (joinChatChannelKey(currentChatId.value) === delCh) {
        void router.push({ name: "home" });
      }
    } catch {
      flashStatus("Could not delete the group. Try again.");
    } finally {
      leaveOrDeleteBusy.value = false;
    }
  }

  function startChatMetaEdit(chatId) {
    const id = joinChatChannelKey(chatId);
    const v = chatsByChannel.value[id]?.value;
    if (!v) return;
    chatMetaDraft.value = {
      title: String(v.title ?? "").slice(0, MAX_GROUP_NAME_LEN),
      description: String(v.description ?? "").trim().slice(0, 2000),
      groupType: String(v.groupType ?? "class").trim() || "class",
    };
    chatMetaEditing.value = true;
  }

  function cancelChatMetaEdit() {
    chatMetaEditing.value = false;
  }

  async function saveChatMeta(chatId) {
    if (!session.value || chatMetaBusy.value) return;
    const id = joinChatChannelKey(chatId);
    const prev = chatsByChannel.value[id]?.value;
    if (!prev) return;
    const title = String(chatMetaDraft.value.title || "").trim().slice(
      0,
      MAX_GROUP_NAME_LEN,
    );
    const description = String(chatMetaDraft.value.description || "")
      .trim()
      .slice(0, 2000);
    const groupType =
      String(chatMetaDraft.value.groupType || "class").trim() || "class";
    if (!title) {
      flashStatus("Title is required.");
      return;
    }
    if (!description) {
      flashStatus("Description is required.");
      return;
    }
    chatMetaBusy.value = true;
    const published = Date.now();
    try {
      await graffiti.post(
        {
          value: {
            activity: "Create",
            type: "Chat",
            title,
            channel: prev.channel,
            published,
            groupType,
            description,
          },
          channels: [DISCOVERY_CHANNEL],
        },
        session.value,
      );
      localChatCreateBump.value = {
        ...localChatCreateBump.value,
        [id]: {
          value: {
            activity: "Create",
            type: "Chat",
            title,
            channel: prev.channel,
            published,
            groupType,
            description,
          },
          actor: session.value.actor,
        },
      };
      flashStatus("Chat details updated.");
      chatMetaEditing.value = false;
    } catch {
      flashStatus("Could not update chat.");
    } finally {
      chatMetaBusy.value = false;
    }
  }

  function toggleChatInfo() {
    chatInfoOpen.value = !chatInfoOpen.value;
    if (chatInfoOpen.value) {
      chatTaskCreateOpen.value = false;
      taskEditingId.value = null;
      closeTaskKebabMenu();
    }
  }

  function setMainPaneTab(tab) {
    mainPaneTab.value = tab;
    taskMenuOpenForTaskId.value = null;
    taskMenuFixedPosition.value = null;
    kebabMenuTask.value = null;
    if (tab === "tasks") {
      chatInfoOpen.value = false;
      chatMetaEditing.value = false;
    }
    if (tab === "messages") {
      chatTaskCreateOpen.value = false;
      taskEditingId.value = null;
      taskExpandedId.value = null;
    }
  }

  function toggleTaskExpanded(taskId) {
    const id = taskId == null ? "" : String(taskId);
    if (!id || id.startsWith("missing-task-")) return;
    taskExpandedId.value = taskExpandedId.value === id ? null : id;
    closeTaskKebabMenu();
  }

  function toggleTaskKebab(task, evt) {
    if (!task?.taskId) return;
    if (taskMenuOpenForTaskId.value === task.taskId) {
      closeTaskKebabMenu();
      return;
    }
    kebabMenuTask.value = task;
    taskMenuOpenForTaskId.value = task.taskId;
    const el = evt?.currentTarget;
    if (el && typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      const menuWidth = 168;
      let left = r.right - menuWidth;
      left = Math.max(10, Math.min(left, window.innerWidth - menuWidth - 10));
      let top = r.bottom + 8;
      const estHeight = 92;
      if (top + estHeight > window.innerHeight - 10) {
        top = Math.max(10, r.top - estHeight - 8);
      }
      taskMenuFixedPosition.value = { top, left };
    } else {
      taskMenuFixedPosition.value = { top: 80, left: 80 };
    }
  }

  function closeTaskKebabMenu() {
    taskMenuOpenForTaskId.value = null;
    taskMenuFixedPosition.value = null;
    kebabMenuTask.value = null;
  }

  function closeMenusOnPointerDownOutside(ev) {
    const raw = ev.target;
    const t =
      raw instanceof Element
        ? raw
        : raw && "parentElement" in raw
          ? raw.parentElement
          : null;
    if (!(t instanceof Element)) return;

    if (chatActionMenuOpen.value && !t.closest(".chat-view__more-wrap")) {
      chatActionMenuOpen.value = false;
    }
    if (
      taskMenuOpenForTaskId.value &&
      !t.closest(".club-chat-task__dropdown--portal") &&
      !t.closest(".club-chat-task__overflow") &&
      !t.closest(".club-chat-task__more-wrap")
    ) {
      closeTaskKebabMenu();
    }
  }

  function closeTaskMenuOnViewportShift() {
    if (taskMenuOpenForTaskId.value) closeTaskKebabMenu();
  }

  onMounted(() => {
    if (session.value?.actor) {
      taskFieldsCache.value = loadTaskFieldMap(session.value.actor);
    }
    document.addEventListener("pointerdown", closeMenusOnPointerDownOutside);
    window.addEventListener("scroll", closeTaskMenuOnViewportShift, true);
    window.addEventListener("resize", closeTaskMenuOnViewportShift);
  });
  onBeforeUnmount(() => {
    document.removeEventListener(
      "pointerdown",
      closeMenusOnPointerDownOutside,
    );
    window.removeEventListener("scroll", closeTaskMenuOnViewportShift, true);
    window.removeEventListener("resize", closeTaskMenuOnViewportShift);
  });



  /** Edit/delete: any signed-in member who can see the chat task. */
  function canManageTask(task) {
    if (!session.value || !task) return false;
    return taskVisibleToSession(task);
  }

  function openTaskCreateForm() {
    closeTaskKebabMenu();
    taskEditingId.value = null;
    taskExpandedId.value = null;
    taskDraft.value = {
      title: "",
      deadlineLocal: "",
      completed: false,
      description: "",
      assigneeActors: session.value?.actor ? [session.value.actor] : [],
    };
    chatTaskCreateOpen.value = true;
  }

  function startEditTask(t) {
    if (!t) return;
    if (!canManageTask(t)) {
      flashStatus("You don't have access to edit this task.");
      closeTaskKebabMenu();
      return;
    }
    closeTaskKebabMenu();
    taskEditingId.value = t.taskId;
    taskExpandedId.value = null;
    const d = new Date(t.deadline);
    const pad = (n) => String(n).padStart(2, "0");
    const local = Number.isNaN(d.getTime())
      ? ""
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const cr =
      String(t.creatorActor || "").trim() ||
      (session.value ? session.value.actor : "");
    const memberSet = new Set(currentChatMemberActors.value);
    const mergedAssignees = normalizeAssigneesInput([
      ...(cr ? [cr] : []),
      ...normalizeAssigneesInput(t.assignees),
    ]);
    taskDraft.value = {
      title: String(t.title || ""),
      deadlineLocal: local,
      completed: Boolean(t.completed),
      description: String(t.description ?? "").trim(),
      assigneeActors: mergedAssignees.filter(
        (a) => memberSet.has(a) || a === cr,
      ),
    };
    chatTaskCreateOpen.value = false;
  }

  function cancelTaskForm() {
    chatTaskCreateOpen.value = false;
    taskEditingId.value = null;
    taskDraft.value = {
      title: "",
      deadlineLocal: "",
      completed: false,
      description: "",
      assigneeActors: [],
    };
  }

  async function onSaveTask() {
    if (!session.value || !currentChatId.value || taskBusy.value) return;
    const title = taskDraft.value.title.trim();
    const description = String(taskDraft.value.description || "")
      .trim()
      .slice(0, 2000);
    const dl = taskDraft.value.deadlineLocal;
    if (!title || !dl) {
      flashStatus("Task needs a title and due date.");
      return;
    }
    if (!description) {
      flashStatus("Task needs a description.");
      return;
    }
    const deadlineMs = new Date(dl).getTime();
    if (Number.isNaN(deadlineMs)) {
      flashStatus("Invalid deadline.");
      return;
    }
    const memberSet = new Set(currentChatMemberActors.value);
    const picked = normalizeAssigneesInput(taskDraft.value.assigneeActors).filter(
      (a) => memberSet.has(a),
    );
    const wasEditing = Boolean(taskEditingId.value);
    const taskId = taskEditingId.value || crypto.randomUUID();
    const existingRow =
      wasEditing &&
      chatTasksVisible.value.find((row) => row.taskId === taskId);
    const creatorActor =
      String(existingRow?.creatorActor || "").trim() || session.value.actor;
    const assignees = normalizeAssigneesInput([creatorActor, ...picked]);
    const ch = joinChatChannelKey(currentChatId.value);
    const published = Date.now();
    const value = {
      activity: "UpsertTask",
      type: TASK_DOC_TYPE,
      taskId,
      title,
      description,
      deadline: deadlineMs,
      assignees,
      completed: Boolean(taskDraft.value.completed),
      published,
    };
    taskBusy.value = true;
    try {
      await graffiti.post(
        {
          value,
          channels: [ch],
        },
        session.value,
      );
      rememberTaskFields(ch, taskId, {
        description,
        assignees,
      });
      rememberLocalTaskUpsert(ch, value, session.value.actor);
      savedTaskHydrationById.value = {
        ...savedTaskHydrationById.value,
        [taskId]: { assignees: [...assignees], description },
      };
      taskDraft.value = {
        title: "",
        deadlineLocal: "",
        completed: false,
        description: "",
        assigneeActors: [],
      };
      chatTaskCreateOpen.value = false;
      taskEditingId.value = null;
      taskExpandedId.value = null;
      flashStatus(wasEditing ? "Task updated." : "Task created.");
    } catch {
      flashStatus("Could not save task.");
    } finally {
      taskBusy.value = false;
    }
  }

  async function onDeleteTask(taskId) {
    if (!session.value || !currentChatId.value || taskBusy.value) return;
    const ch = joinChatChannelKey(currentChatId.value);
    const task =
      chatTasksVisible.value.find((t) => t.taskId === taskId) ??
      allJoinedTasksList.value.find(
        (t) => t.taskId === taskId && joinChatChannelKey(t.chatId) === ch,
      );
    if (!task) {
      flashStatus("Task is no longer available.");
      closeTaskKebabMenu();
      return;
    }
    if (!canManageTask(task)) {
      flashStatus("You don't have access to delete this task.");
      closeTaskKebabMenu();
      return;
    }
    const label = (task.title || "Untitled task").trim() || "Untitled task";
    if (
      !window.confirm(
        `Remove "${label}" for everyone in this group? This cannot be undone.`,
      )
    ) {
      return;
    }
    closeTaskKebabMenu();
    taskBusy.value = true;
    const value = {
      activity: "DeleteTask",
      type: TASK_DOC_TYPE,
      taskId,
      published: Date.now(),
    };
    try {
      await graffiti.post(
        {
          value,
          channels: [ch],
        },
        session.value,
      );
      flashStatus("Task removed.");
      rememberLocalTaskDelete(ch, value, session.value.actor);
      forgetTaskFields(ch, taskId);
      {
        const next = { ...savedTaskHydrationById.value };
        delete next[taskId];
        savedTaskHydrationById.value = next;
      }
    } catch {
      flashStatus("Could not remove task.");
    } finally {
      taskBusy.value = false;
    }
  }

  /**
   * One-time admin helper exposed on `window.__deleteAllMyTasks()`.
   * Posts a DeleteTask for every task the current user can manage
   * (creator, or owner of the chat the task belongs to) across all joined chats.
   */
  async function deleteAllManageableTasks() {
    if (!session.value) {
      console.warn("[__deleteAllMyTasks] not signed in");
      return { deleted: 0, skipped: 0 };
    }
    const targets = [];
    for (const t of allJoinedTasksList.value) {
      const me = session.value.actor;
      const chatChan = joinChatChannelKey(t.chatId);
      const chatRec = chatsByChannel.value[chatChan];
      const owns = chatRec?.actor === me;
      const created = t.creatorActor === me;
      if (owns || created) targets.push(t);
    }
    if (targets.length === 0) {
      console.info("[__deleteAllMyTasks] no manageable tasks found");
      return { deleted: 0, skipped: 0 };
    }
    if (
      !window.confirm(
        `Permanently delete ${targets.length} task(s) you created or own? This cannot be undone.`,
      )
    ) {
      return { deleted: 0, skipped: targets.length };
    }
    let deleted = 0;
    let skipped = 0;
    for (const t of targets) {
      try {
        await graffiti.post(
          {
            value: {
              activity: "DeleteTask",
              type: TASK_DOC_TYPE,
              taskId: t.taskId,
              published: Date.now(),
            },
            channels: [joinChatChannelKey(t.chatId)],
          },
          session.value,
        );
        deleted += 1;
      } catch (e) {
        skipped += 1;
        console.warn("[__deleteAllMyTasks] failed for", t.taskId, e);
      }
    }
    flashStatus(`Removed ${deleted} task${deleted === 1 ? "" : "s"}.`);
    return { deleted, skipped };
  }

  if (typeof window !== "undefined") {
    window.__deleteAllMyTasks = deleteAllManageableTasks;
  }

  async function toggleTaskComplete(chatId, task) {
    if (!session.value || !task?.taskId || taskBusy.value) return;
    const ch = joinChatChannelKey(chatId);
    if (!ch) return;
    const key = taskToggleBusyKey(ch, task.taskId);
    if (taskCompleteBusy.value[key]) return;
    taskCompleteBusy.value = { ...taskCompleteBusy.value, [key]: true };
    const description = String(task.description ?? "").trim().slice(0, 2000);
    const cr = String(task.creatorActor || "").trim();
    const assignees = normalizeAssigneesInput([
      ...(cr ? [cr] : []),
      ...normalizeAssigneesInput(task.assignees),
    ]);
    const value = {
      activity: "UpsertTask",
      type: TASK_DOC_TYPE,
      taskId: task.taskId,
      title: task.title,
      description,
      deadline: task.deadline,
      assignees,
      completed: !task.completed,
      published: Date.now(),
    };
    try {
      await graffiti.post(
        {
          value,
          channels: [ch],
        },
        session.value,
      );
      rememberTaskFields(ch, task.taskId, { description, assignees });
      rememberLocalTaskUpsert(ch, value, session.value.actor);
      savedTaskHydrationById.value = {
        ...savedTaskHydrationById.value,
        [task.taskId]: { assignees: [...assignees], description },
      };
    } catch {
      flashStatus("Could not update task status.");
    } finally {
      const next = { ...taskCompleteBusy.value };
      delete next[key];
      taskCompleteBusy.value = next;
    }
  }

  async function goToChatTasks(chatId, taskId) {
    suppressMainPaneReset.value = true;
    chatTaskFilter.value = "all";
    mainPaneTab.value = "tasks";
    sidebarPaneTab.value = "tasks";
    chatInfoOpen.value = false;
    closeTaskKebabMenu();
    try {
      if (joinChatChannelKey(currentChatId.value) !== joinChatChannelKey(chatId)) {
        await router.push({
          name: "chat",
          params: { chatId: joinChatChannelKey(chatId) },
        });
        await nextTick();
      }
      await nextTick();
      requestAnimationFrame(() => {
        document
          .getElementById(`task-row-${taskId}`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    } finally {
      suppressMainPaneReset.value = false;
    }
  }

  function formatTaskDeadline(ms) {
    if (ms == null || ms === "") return "—";
    const n = Number(ms);
    if (Number.isNaN(n)) return "—";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(d);
    } catch {
      return "—";
    }
  }

  const MAX_PROFILE_PHOTO_CHARS = 480000;

  /**
   * @param {File} file
   * @returns {Promise<string>}
   */
  function resizeImageToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const maxSide = 160;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
          resolve(dataUrl);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image"));
      };
      img.src = url;
    });
  }

  async function onProfilePhotoInput(ev) {
    const input = ev.target;
    const file = input?.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    try {
      let dataUrl = await resizeImageToDataUrl(file);
      if (dataUrl.length > MAX_PROFILE_PHOTO_CHARS) {
        flashStatus("Photo is still too large after resize.");
        return;
      }
      profileDraft.value.avatarPhotoDataUrl = dataUrl;
      flashStatus("Photo added — Save profile to keep it.");
    } catch {
      flashStatus("Could not read that image.");
    }
    input.value = "";
  }

  function clearProfileDraftPhoto() {
    profileDraft.value.avatarPhotoDataUrl = "";
  }

  function groupTagClass(tagId) {
    return `group-tag group-tag--${(tagId || "other").replace(/[^a-z0-9-]/gi, "") || "other"}`;
  }

  function groupDotClass(tagId) {
    return `chat-dot chat-dot--${(tagId || "other").replace(/[^a-z0-9-]/gi, "") || "other"}`;
  }

  function groupTypeLabel(id) {
    return GROUP_TAG_OPTIONS.find((t) => t.id === id)?.label || id || "Group";
  }

  function resolveAvatarEmoji(key) {
    const k = key || "fern";
    return AVATAR_PRESETS.find((a) => a.id === k)?.emoji ?? AVATAR_PRESETS[0].emoji;
  }

  function startProfileEdit() {
    profileDraft.value = {
      displayName: "",
      classYear: "",
      major: "",
      bio: "",
      avatarKey: "fern",
      avatarPhotoDataUrl: "",
      ...selfProfile.value,
    };
    profileEditing.value = true;
  }

  function cancelProfileEdit() {
    loadUserProfile();
    profileEditing.value = false;
  }

  async function saveUserProfile() {
    if (!session.value) return;
    const ak = String(profileDraft.value.avatarKey || "fern").trim() || "fern";
    const photo = String(
      profileDraft.value.avatarPhotoDataUrl || "",
    ).trim();
    if (photo.length > MAX_PROFILE_PHOTO_CHARS) {
      flashStatus("Profile photo is too large; remove it or use a smaller image.");
      return;
    }
    const networkPhoto =
      photo.length <= MAX_PROFILE_NETWORK_CHARS ? photo : "";
    selfProfile.value = {
      displayName: String(profileDraft.value.displayName || "").trim(),
      classYear: String(profileDraft.value.classYear || "").trim(),
      major: String(profileDraft.value.major || "").trim(),
      bio: String(profileDraft.value.bio || "").trim().slice(0, 2000),
      avatarKey: ak,
      avatarPhotoDataUrl: photo,
    };
    try {
      localStorage.setItem(
        `${PROFILE_KEY_PREFIX}/${session.value.actor}`,
        JSON.stringify(selfProfile.value),
      );
    } catch {
      /* ignore */
    }
    if (selfProfile.value.displayName) {
      handleByActor.value = {
        ...handleByActor.value,
        [session.value.actor]: selfProfile.value.displayName,
      };
    } else {
      const n = { ...handleByActor.value };
      delete n[session.value.actor];
      handleByActor.value = n;
    }
    try {
      await graffiti.post(
        {
          value: {
            activity: "UpsertProfile",
            type: PROFILE_DOC_TYPE,
            displayName: selfProfile.value.displayName,
            avatarKey: ak,
            avatarPhotoDataUrl: networkPhoto,
            published: Date.now(),
          },
          channels: [DISCOVERY_CHANNEL],
        },
        session.value,
      );
    } catch {
      flashStatus("Profile saved locally; network sync failed.");
      profileEditing.value = false;
      return;
    }
    profileEditing.value = false;
    flashStatus(
      photo.length > MAX_PROFILE_NETWORK_CHARS
        ? "Profile saved. Photo too large to sync — others see your emoji until you use a smaller image."
        : "Profile saved.",
    );
  }

  async function onSelectChat(chatId) {
    const id = joinChatChannelKey(chatId);
    if (!id || joinBusy.value[id]) return;
    if (!session.value) {
      flashStatus("Sign in to join a group.");
      return;
    }
    if (!hasJoined(id)) {
      joinBusy.value = { ...joinBusy.value, [id]: true };
      try {
        await postJoin(id);
      } catch {
        flashStatus("Could not join this group. Try again.");
        return;
      } finally {
        const next = { ...joinBusy.value };
        delete next[id];
        joinBusy.value = next;
      }
    }
    sidebarPaneTab.value = "chats";
    void router.push({ name: "chat", params: { chatId: id } });
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

  function scrollMessagesToBottom() {
    const el = messagesPanelRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function focusComposerAfterOpen() {
    nextTick(() => {
      requestAnimationFrame(() => {
        scrollMessagesToBottom();
        composerInputRef.value?.focus();
      });
    });
  }

  function closeChat() {
    void router.push({ name: "home" });
  }

  // Sync current chat to URL: deep links, back/forward, in-app navigation.
  watch(
    () => [route.name, route.params.chatId, session.value?.actor],
    async () => {
      if (route.name === "chat" && route.params.chatId) {
        const id = joinChatChannelKey(route.params.chatId);
        if (!id) {
          void router.push({ name: "home" });
          return;
        }
        if (!session.value) {
          void router.push({ name: "home" });
          return;
        }
        if (!isAllChatsLoading.value && !isInboxLoading.value) {
          if (!chatsByChannel.value[id]) {
            void router.push({ name: "home" });
            return;
          }
        }
        if (!hasJoined(id)) {
          if (joinBusy.value[id]) return;
          joinBusy.value = { ...joinBusy.value, [id]: true };
          try {
            await postJoin(id);
          } catch {
            flashStatus("Could not join this group. Try again.");
            void router.push({ name: "home" });
            return;
          } finally {
            const next = { ...joinBusy.value };
            delete next[id];
            joinBusy.value = next;
          }
        }
        const changed = currentChatId.value !== id;
        currentChatId.value = id;
        markChatSeen(id);
        if (changed) {
          focusComposerAfterOpen();
        }
        if (!isAllChatsLoading.value) {
          if (!chatsByChannel.value[id]) {
            void router.push({ name: "home" });
            return;
          }
        }
      } else if (
        route.name === "home" ||
        route.name === "profile" ||
        route.name === "newchat" ||
        route.name === "explore"
      ) {
        if (currentChatId.value) {
          markChatSeen(currentChatId.value);
        }
        currentChatId.value = null;
      }
    },
    { immediate: true },
  );

  watch(currentChatId, () => {
    chatInfoOpen.value = false;
    chatActionMenuOpen.value = false;
    if (!suppressMainPaneReset.value) {
      mainPaneTab.value = "messages";
    }
    chatTaskCreateOpen.value = false;
    taskEditingId.value = null;
    taskExpandedId.value = null;
    taskMenuOpenForTaskId.value = null;
    taskMenuFixedPosition.value = null;
    kebabMenuTask.value = null;
    chatMetaEditing.value = false;
    chatTaskFilter.value = "all";
  });

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
    const remote = remoteProfileByActor.value[actor];
    if (remote?.displayName) return remote.displayName;
    if (session.value?.actor === actor && selfProfile.value?.displayName?.trim()) {
      return selfProfile.value.displayName.trim();
    }
    const hit = handleByActor.value[actor];
    if (hit) return hit;
    return shortDidTail(actor);
  }

  function messageAvatarPhoto(actor) {
    if (!actor) return "";
    const remote = remoteProfileByActor.value[actor];
    if (remote?.avatarPhotoDataUrl) return remote.avatarPhotoDataUrl;
    if (session.value?.actor === actor && selfProfile.value?.avatarPhotoDataUrl) {
      return selfProfile.value.avatarPhotoDataUrl;
    }
    return "";
  }

  function messageAvatarEmoji(actor) {
    if (messageAvatarPhoto(actor)) return "";
    const remote = remoteProfileByActor.value[actor];
    if (remote?.avatarKey) return resolveAvatarEmoji(remote.avatarKey);
    if (session.value?.actor === actor) {
      return resolveAvatarEmoji(selfProfile.value?.avatarKey);
    }
    return "";
  }

  function messageAvatarInitials(actor) {
    const raw = graffitiDisplayName(actor).trim() || "?";
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const a = parts[0][0] || "?";
      const b = parts[parts.length - 1][0] || "?";
      return (a + b).toUpperCase();
    }
    return raw.slice(0, 2).toUpperCase();
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
    newChatTitle,
    newChatDescription,
    newGroupType,
    draftMessage,
    chatInfoOpen,
    chatActionMenuOpen,
    mainPaneTab,
    sidebarPaneTab,
    chatTaskCreateOpen,
    taskEditingId,
    taskExpandedId,
    taskMenuOpenForTaskId,
    taskMenuFixedPosition,
    kebabMenuTask,
    chatMetaEditing,
    chatMetaDraft,
    chatMetaBusy,
    taskDraft,
    taskBusy,
    leaveOrDeleteBusy,
    selfProfile,
    profileEditing,
    profileDraft,
    exploreInfoChannel,
    exploreInfoChat,
    explorePublicChatCount,
    explorePreviewMemberActors,
    chatTasksVisible,
    chatTasksFiltered,
    chatTaskRowsForDisplay,
    allJoinedTasksList,
    sidebarJoinedTasksFiltered,
    createBusy,
    sendBusy,
    joinBusy,
    joinChatChannelKey,
    taskCompleteBusy,
    sidebarTaskFilter,
    chatTaskFilter,
    statusMessage,
    isNarrow,
    composerInputRef,
    messagesPanelRef,
    GROUP_TAG_OPTIONS,
    AVATAR_PRESETS,
    // data
    allChatsSorted,
    discoverUnjoinedChats,
    myChats,
    sortedMessages,
    messageTimeline,
    currentChatMemberActors,
    isRosterLoading,
    // loading
    isAllChatsLoading,
    isAnyListLoading,
    areMessagesLoading,
    // actions
    onCreateChat,
    onSelectChat,
    onSendMessage,
    onLeaveGroup,
    onDeleteGroup,
    closeChat,
    startProfileEdit,
    cancelProfileEdit,
    saveUserProfile,
    toggleChatInfo,
    toggleTaskKebab,
    closeTaskKebabMenu,
    toggleTaskExpanded,
    setMainPaneTab,
    startChatMetaEdit,
    cancelChatMetaEdit,
    saveChatMeta,
    openTaskCreateForm,
    startEditTask,
    cancelTaskForm,
    onSaveTask,
    onDeleteTask,
    toggleTaskComplete,
    taskToggleBusyKey,
    goToChatTasks,
    formatTaskDeadline,
    onProfilePhotoInput,
    clearProfileDraftPhoto,
    // helpers
    hasJoined,
    isChatOwner,
    canManageTask,
    chatTitle,
    chatDescriptionText,
    chatGroupType,
    groupTagClass,
    groupDotClass,
    groupTypeLabel,
    resolveAvatarEmoji,
    MAX_GROUP_NAME_LEN,
    unreadCount,
    formatMessageTime,
    formatDayDivider,
    displayActor,
    graffitiDisplayName,
    messageAvatarPhoto,
    messageAvatarEmoji,
    messageAvatarInitials,
    peerAccentHue,
  };
}
