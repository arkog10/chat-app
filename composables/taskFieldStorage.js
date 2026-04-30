/**
 * Persists UpsertTask `description` / `assignees` when Graffiti discover omits them.
 * Channel keys MUST match {@link normalizeChannelKey} (same trimming as joinChatChannelKey).
 */

export const TASK_FIELD_STORAGE_PREFIX = "chat-app/task-fields/v1";

/**
 * Mirrors `joinChatChannelKey(chatId)` in useClubChat so cache rows line up with
 * `channelFromObject` / UUID strings from discover.
 *
 * @param {unknown} k
 */
export function normalizeChannelKey(k) {
  if (k == null || k === "") return "";
  return String(k).trim();
}

export function storageKeyForActor(actor) {
  return `${TASK_FIELD_STORAGE_PREFIX}:${actor}`;
}

/**
 * Graffiti UpsertTask may expose assignees as a string[] or as a keyed object (`Record<id, truthy>`).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeAssigneesInput(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    const seen = new Set();
    const out = [];
    for (const x of raw) {
      if (x == null || x === "") continue;
      const s = typeof x === "string" ? x : typeof x === "number" ? String(x) : "";
      const t = typeof s === "string" ? s.trim() : "";
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }
  if (typeof raw === "object") {
    const seen = new Set();
    const out = [];
    for (const [k, v] of Object.entries(raw)) {
      if (!v || k == null || k === "") continue;
      const t = String(k).trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

/** @typedef {{ description?: string, assignees?: string[] }} TaskFieldSlot */
/** @typedef {Record<string, Record<string, TaskFieldSlot>>} TaskFieldMap */

/** @param {Record<string, unknown>} raw */
function coerceAndMigrateMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  /** @type {TaskFieldMap} */
  const out = {};
  for (const [ch, tasks] of Object.entries(raw)) {
    const nk = normalizeChannelKey(ch);
    if (!nk || !tasks || typeof tasks !== "object") continue;
    const prev = out[nk] || {};
    out[nk] = { ...prev, ...tasks };
  }
  return out;
}

/**
 * @param {string} actor
 * @returns {TaskFieldMap}
 */
export function loadTaskFieldMap(actor) {
  if (!actor) return {};
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(storageKeyForActor(actor));
    if (!raw) return {};
    const p = JSON.parse(raw);
    return coerceAndMigrateMap(typeof p === "object" ? p : {});
  } catch {
    return {};
  }
}

/**
 * @param {string} actor
 * @param {TaskFieldMap} map
 */
export function saveTaskFieldMap(actor, map) {
  if (!actor) return;
  try {
    localStorage.setItem(storageKeyForActor(actor), JSON.stringify(map));
  } catch {
    /* quota */
  }
}

/**
 * @param {string[]} primary
 * @param {string[]} secondary
 */
/**
 * Dedup-preserving concatenation — exported for UI + drafts.
 */
export function mergeAssigneeLists(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const x of primary) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  for (const x of secondary) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * Locate cached slot tolerating legacy / mixed channel key strings.
 */
export function pickTaskSlot(map, channelKey, taskId) {
  const nk = normalizeChannelKey(channelKey);
  const direct =
    map[nk]?.[taskId] ||
    (nk !== channelKey ? map[channelKey]?.[taskId] : undefined);
  if (direct) return direct;
  for (const [k, chMap] of Object.entries(map || {})) {
    if (!chMap?.[taskId]) continue;
    if (normalizeChannelKey(k) === nk) return chMap[taskId];
  }
  return undefined;
}

/**
 * @param {object} task
 * @param {string} channelKey
 * @param {TaskFieldMap} map
 */
export function mergeTaskFieldsFromStorage(task, channelKey, map) {
  if (!channelKey || !task?.taskId) return task;

  const slot =
    map && typeof map === "object"
      ? pickTaskSlot(map, channelKey, task.taskId)
      : undefined;

  const netDesc =
    typeof task.description === "string" && task.description.trim() !== ""
      ? task.description
      : "";
  const cacheDesc =
    slot &&
    typeof slot.description === "string" &&
    slot.description.trim() !== ""
      ? slot.description
      : "";
  const description = netDesc || cacheDesc;

  const netAsg = normalizeAssigneesInput(task.assignees);
  const cacheRaw = slot ? normalizeAssigneesInput(slot.assignees) : [];
  /** Discover first order, then localStorage when discover omitted / wrong shape */
  const assignees = mergeAssigneeLists(netAsg, cacheRaw);

  const merged = { ...task, description, assignees };
  const sameDesc = (task.description || "") === merged.description;
  const sameAsg =
    JSON.stringify(normalizeAssigneesInput(task.assignees)) ===
    JSON.stringify(merged.assignees);
  /* Don't return stale `task` when assignees are still object-shaped from discover — breaks `v-for`. */
  if (sameDesc && sameAsg && Array.isArray(task.assignees)) return task;
  return merged;
}

/**
 * Immutable patch update for one task slot (storage root uses normalized channels).
 *
 * @param {TaskFieldMap} root
 * @param {string} channelKey
 * @param {string} taskId
 * @param {Partial<TaskFieldSlot>} patch
 */
export function rememberTaskDetail(root, channelKey, taskId, patch) {
  const nk = normalizeChannelKey(channelKey);
  if (!nk || !taskId) return root;
  const prevMap = root[nk] || {};
  const prev = prevMap[taskId] || {};
  const nextSlot = { ...prev };
  if ("description" in patch) {
    nextSlot.description =
      patch.description == null
        ? ""
        : String(patch.description).slice(0, 2000);
  }
  if ("assignees" in patch && patch.assignees != null) {
    nextSlot.assignees = normalizeAssigneesInput(patch.assignees);
  }
  return {
    ...root,
    [nk]: { ...prevMap, [taskId]: nextSlot },
  };
}

/**
 * @param {TaskFieldMap} root
 * @param {string} channelKey
 * @param {string} taskId
 */
export function forgetTaskDetail(root, channelKey, taskId) {
  const nk = normalizeChannelKey(channelKey);
  if (!taskId) return root;

  let hostKey = nk;
  if (!root[hostKey]?.[taskId]) {
    hostKey = "";
    for (const [k, chMap] of Object.entries(root || {})) {
      if (!chMap?.[taskId]) continue;
      if (normalizeChannelKey(k) === nk) {
        hostKey = k;
        break;
      }
    }
    if (!hostKey) return root;
  }

  const prevMap = root[hostKey];
  if (!prevMap?.[taskId]) return root;
  const nextCh = { ...prevMap };
  delete nextCh[taskId];
  const nr = { ...root };
  if (Object.keys(nextCh).length === 0) delete nr[hostKey];
  else nr[hostKey] = nextCh;
  return nr;
}
