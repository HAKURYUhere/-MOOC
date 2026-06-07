const DEFAULT_SETTINGS = {
  reminderHours: 24,
  scanIntervalMinutes: 30,
  notifyEnabled: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await scheduleScanAlarm();
});

chrome.runtime.onStartup.addListener(scheduleScanAlarm);

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
  const { tasks = [] } = await chrome.storage.local.get("tasks");
  const byKey = new Map(tasks.map((task) => [task.id, task]));

  for (const task of incomingTasks || []) {
    if (!task?.title) continue;

    const enriched = {
      ...task,
      course: task.course || getCourseFromTitle(tab?.title) || "中国大学 MOOC",
      pageUrl: task.pageUrl || tab?.url || "",
      lastSeenAt: now,
      source: "content-script"
    };

    byKey.set(enriched.id, { ...byKey.get(enriched.id), ...enriched });
  }

  const nextTasks = Array.from(byKey.values())
    .filter((task) => !task.lastSeenAt || now - task.lastSeenAt < 1000 * 60 * 60 * 24 * 30)
    .sort((a, b) => (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER));

  await chrome.storage.local.set({ tasks: nextTasks });
  await notifyDueTasks();
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
