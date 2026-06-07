const DEFAULT_SETTINGS = {
  reminderHours: 24,
  scanIntervalMinutes: 30,
  notifyEnabled: true
};
const DAY_MS = 24 * 60 * 60 * 1000;
const SILENCE_OVERDUE_AFTER_MS = 7 * DAY_MS;

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await cleanupTasks();
  await scheduleScanAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await cleanupTasks();
  await scheduleScanAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "mooc-task-scan") {
    await notifyDueTasks();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MOOC_TASKS_FOUND") {
    saveTasks(message.tasks, sender.tab).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "MOOC_REFRESH_ALARM") {
    scheduleScanAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "MOOC_FETCH_HTML") {
    fetchHtml(message.url).then((html) => sendResponse({ ok: Boolean(html), html }));
    return true;
  }

  if (message?.type === "MOOC_CLEANUP_TASKS") {
    cleanupTasks().then((result) => sendResponse({ ok: true, ...result }));
    return true;
  }

  return false;
});

async function scheduleScanAlarm() {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  chrome.alarms.create("mooc-task-scan", {
    periodInMinutes: Math.max(5, Number(settings.scanIntervalMinutes) || 30)
  });
}

async function saveTasks(incomingTasks, tab) {
  const now = Date.now();
  const { tasks = [], silencedTaskKeys = {} } = await chrome.storage.local.get(["tasks", "silencedTaskKeys"]);
  const byKey = new Map(tasks.map((task) => [task.id, task]));
  const nextSilencedTaskKeys = { ...silencedTaskKeys };

  for (const task of incomingTasks || []) {
    if (!isValidStoredTask(task)) continue;
    const silenceKey = getSilenceKey(task);
    if (nextSilencedTaskKeys[silenceKey]) continue;
    if (shouldSilenceTask(task, now)) {
      nextSilencedTaskKeys[silenceKey] = now;
      byKey.delete(task.id);
      continue;
    }

    const enriched = {
      ...task,
      course: task.course || getCourseFromTitle(tab?.title) || "中国大学 MOOC",
      pageUrl: task.pageUrl || tab?.url || "",
      lastSeenAt: now,
      source: "content-script"
    };

    if (shouldSilenceTask(enriched, now)) {
      nextSilencedTaskKeys[silenceKey] = now;
      byKey.delete(enriched.id);
      continue;
    }

    byKey.set(enriched.id, { ...byKey.get(enriched.id), ...enriched });
  }

  const { activeTasks, silencedTaskKeys: cleanedSilencedTaskKeys } = normalizeTasks(
    Array.from(byKey.values()),
    nextSilencedTaskKeys,
    now
  );

  await chrome.storage.local.set({ tasks: activeTasks, silencedTaskKeys: cleanedSilencedTaskKeys });
  await notifyDueTasks();
}

function isValidStoredTask(task) {
  if (!task?.title || task.done) return Boolean(task?.title);
  if (!task.dueAt) return false;

  const title = String(task.title || "").replace(/\s+/g, " ").trim();
  if (!title || title.length < 2 || title.length > 80) return false;
  if (/^(id|courseStyle|style|type|name|title|content|chapterId|lessonId)\b/i.test(title)) return false;
  if (/\b(courseStyle|chapterId|lessonId|contentId|categoryId|termId)\b/i.test(title)) return false;
  if (/^[\w-]+\s*[:：]/.test(title) && !/(作业|互评|测验|测试|考试|讨论|问卷)/.test(title)) return false;
  if (/^[\d\s()[\]（）-]+$/.test(title)) return false;
  if (/(已结课|课程已结束|已结束课程|课程结束|已关闭|已归档)/.test(`${task.course || ""} ${task.capturedText || ""}`)) return false;
  return true;
}

async function notifyDueTasks() {
  const { tasks = [], settings = DEFAULT_SETTINGS, notified = {} } = await chrome.storage.local.get([
    "tasks",
    "settings",
    "notified"
  ]);

  if (!settings.notifyEnabled) return;

  const now = Date.now();
  const reminderWindow = Math.max(1, Number(settings.reminderHours) || 24) * 60 * 60 * 1000;
  const nextNotified = { ...notified };

  for (const task of tasks) {
    if (task.done || !task.dueAt) continue;
    if (shouldSilenceTask(task, now)) continue;

    const isDueSoon = task.dueAt >= now && task.dueAt - now <= reminderWindow;
    const isOverdue = task.dueAt < now;
    const notificationKey = `${task.id}:${new Date(task.dueAt).toDateString()}`;

    if ((isDueSoon || isOverdue) && !nextNotified[notificationKey]) {
      const when = isOverdue ? "已截止" : `截止：${formatDateTime(task.dueAt)}`;
      await chrome.notifications.create(notificationKey, {
        type: "basic",
        iconUrl: "icon128.png",
        title: isOverdue ? "MOOC 有任务已截止" : "MOOC 任务即将截止",
        message: `${task.course || "中国大学 MOOC"}｜${task.title}｜${when}`,
        priority: 1
      });
      nextNotified[notificationKey] = Date.now();
    }
  }

  await chrome.storage.local.set({ notified: nextNotified });
}

async function cleanupTasks() {
  const now = Date.now();
  const { tasks = [], silencedTaskKeys = {} } = await chrome.storage.local.get(["tasks", "silencedTaskKeys"]);
  const result = normalizeTasks(tasks, silencedTaskKeys, now);
  await chrome.storage.local.set({
    tasks: result.activeTasks,
    silencedTaskKeys: result.silencedTaskKeys
  });
  return {
    activeCount: result.activeTasks.length,
    silencedCount: result.silencedCount
  };
}

function normalizeTasks(tasks, silencedTaskKeys, now) {
  const nextSilencedTaskKeys = { ...silencedTaskKeys };
  let silencedCount = 0;

  const activeTasks = [];
  for (const task of tasks) {
    if (!isValidStoredTask(task)) continue;
    const silenceKey = getSilenceKey(task);
    if (nextSilencedTaskKeys[silenceKey]) {
      silencedCount += 1;
      continue;
    }
    if (shouldSilenceTask(task, now)) {
      nextSilencedTaskKeys[silenceKey] = now;
      silencedCount += 1;
      continue;
    }
    if (task.lastSeenAt && now - task.lastSeenAt >= 1000 * 60 * 60 * 24 * 30) continue;
    activeTasks.push(task);
  }

  return {
    activeTasks: activeTasks.sort((a, b) => (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER)),
    silencedTaskKeys: pruneSilencedKeys(nextSilencedTaskKeys, now),
    silencedCount
  };
}

function shouldSilenceTask(task, now = Date.now()) {
  return Boolean(task?.dueAt && now - Number(task.dueAt) > SILENCE_OVERDUE_AFTER_MS);
}

function getSilenceKey(task) {
  return simpleHash(
    [
      normalizeKeyPart(task.course),
      normalizeKeyPart(task.title),
      normalizeKeyPart((task.pageUrl || "").split("#")[0])
    ].join("|")
  );
}

function pruneSilencedKeys(silencedTaskKeys, now) {
  const next = {};
  for (const [key, timestamp] of Object.entries(silencedTaskKeys || {})) {
    if (now - Number(timestamp) < 1000 * 60 * 60 * 24 * 120) {
      next[key] = timestamp;
    }
  }
  return next;
}

function normalizeKeyPart(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function simpleHash(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return `silent-${Math.abs(hash)}`;
}

function getCourseFromTitle(title = "") {
  return title
    .replace(/中国大学MOOC|中国大学 MOOC|慕课|网易云课堂/gi, "")
    .replace(/[-_|]/g, " ")
    .trim();
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

async function fetchHtml(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)icourse163\.org$|(^|\.)universitymooc\.com$/.test(parsed.hostname)) {
      return "";
    }

    const response = await fetch(parsed.href, {
      credentials: "include",
      cache: "no-store"
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/html")) return "";
    return await response.text();
  } catch (_error) {
    return "";
  }
}
