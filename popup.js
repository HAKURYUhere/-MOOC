const taskList = document.querySelector("#taskList");
const summary = document.querySelector("#summary");
const taskTemplate = document.querySelector("#taskTemplate");
const scanCurrent = document.querySelector("#scanCurrent");
const openOptions = document.querySelector("#openOptions");
const clearDone = document.querySelector("#clearDone");
const tabs = document.querySelectorAll(".tab");

let currentFilter = "day";
let cachedTasks = [];

document.addEventListener("DOMContentLoaded", render);
scanCurrent.addEventListener("click", scanCurrentTab);
openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
clearDone.addEventListener("click", clearCompletedTasks);

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    currentFilter = tab.dataset.filter;
    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    renderTasks(cachedTasks);
  });
}

async function render() {
  const { tasks = [] } = await chrome.storage.local.get("tasks");
  cachedTasks = tasks;
  renderTasks(tasks);
}

function renderTasks(tasks) {
  taskList.innerHTML = "";

  const activeTasks = tasks.filter((task) => !task.done);
  const displayableTasks = activeTasks.filter(isDisplayableTask);
  const dayTasks = displayableTasks.filter((task) => getPriority(task) === "day" || getPriority(task) === "overdue");
  const weekTasks = displayableTasks.filter((task) => ["day", "week", "overdue"].includes(getPriority(task)));
  const monthTasks = displayableTasks.filter((task) => ["day", "week", "month", "overdue"].includes(getPriority(task)));
  const filtered = filterTasks(tasks);

  summary.textContent = `${displayableTasks.length} 个待完成｜1天 ${dayTasks.length}｜1周 ${weekTasks.length}｜1月 ${monthTasks.length}`;

  if (filtered.length === 0) {
    taskList.innerHTML = `<div class="empty">没有匹配的任务。登录后打开中国大学 MOOC 首页或“我的课程”页，再点右上角刷新试试。</div>`;
    return;
  }

  for (const task of filtered) {
    const node = taskTemplate.content.cloneNode(true);
    const article = node.querySelector(".task");
    const title = node.querySelector("h2");
    const course = node.querySelector(".course");
    const pill = node.querySelector(".pill");
    const due = node.querySelector(".due");
    const openButton = node.querySelector(".open-task");
    const doneButton = node.querySelector(".toggle-done");

    article.classList.toggle("done", task.done);
    article.classList.toggle("overdue", task.dueAt && task.dueAt < Date.now() && !task.done);
    article.dataset.priority = getPriority(task);
    title.textContent = task.title;
    course.textContent = task.course || "中国大学 MOOC";
    pill.textContent = `${priorityLabel(task)} · ${task.type || "任务"}${task.confidence === "medium" ? " · 待核对" : ""}`;
    due.textContent = formatDue(task);
    openButton.addEventListener("click", () => openTask(task));
    doneButton.textContent = task.done ? "恢复" : "完成";
    doneButton.addEventListener("click", () => toggleDone(task.id));

    taskList.appendChild(node);
  }
}

function filterTasks(tasks) {
  const sorted = tasks
    .filter(isDisplayableTask)
    .sort((a, b) => (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER));

  if (currentFilter === "day") {
    return sorted.filter((task) => !task.done && ["day", "overdue"].includes(getPriority(task)));
  }

  if (currentFilter === "week") {
    return sorted.filter((task) => !task.done && ["day", "week", "overdue"].includes(getPriority(task)));
  }

  if (currentFilter === "month") {
    return sorted.filter((task) => !task.done && ["day", "week", "month", "overdue"].includes(getPriority(task)));
  }

  return sorted;
}

async function scanCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await chrome.tabs.sendMessage(tab.id, { type: "MOOC_SCAN_NOW" }).catch(() => {});
  setTimeout(render, 900);
}

async function openTask(task) {
  if (!task.pageUrl) return;
  await chrome.tabs.create({ url: task.pageUrl });
}

async function toggleDone(taskId) {
  const { tasks = [] } = await chrome.storage.local.get("tasks");
  const nextTasks = tasks.map((task) => (task.id === taskId ? { ...task, done: !task.done } : task));
  await chrome.storage.local.set({ tasks: nextTasks });
  cachedTasks = nextTasks;
  renderTasks(nextTasks);
}

async function clearCompletedTasks() {
  const { tasks = [] } = await chrome.storage.local.get("tasks");
  const nextTasks = tasks.filter((task) => !task.done);
  await chrome.storage.local.set({ tasks: nextTasks });
  cachedTasks = nextTasks;
  renderTasks(nextTasks);
}

function formatDue(task) {
  if (task.done) return "已完成";
  if (!task.dueAt) return task.status === "overdue" ? "已截止" : "未识别截止时间";

  const diff = task.dueAt - Date.now();
  if (diff < 0) return `已截止 ${formatDateTime(task.dueAt)}`;
  if (diff < 60 * 60 * 1000) return "1 小时内截止";
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / 60 / 60 / 1000)} 小时内截止`;
  return `截止 ${formatDateTime(task.dueAt)}`;
}

function getPriority(task) {
  if (task.priority) return task.priority;
  if (!task.dueAt) return "unknown";

  const diff = task.dueAt - Date.now();
  if (diff < 0) return "overdue";
  if (diff <= 24 * 60 * 60 * 1000) return "day";
  if (diff <= 7 * 24 * 60 * 60 * 1000) return "week";
  if (diff <= 30 * 24 * 60 * 60 * 1000) return "month";
  return "later";
}

function priorityLabel(task) {
  const priority = getPriority(task);
  if (priority === "overdue") return "已截止";
  if (priority === "day") return "1天";
  if (priority === "week") return "1周";
  if (priority === "month") return "1月";
  return "较远";
}

function isDisplayableTask(task) {
  if (!task?.title || task.done) return false;
  if (!isValidTaskTitle(task.title)) return false;
  if (/(已结课|课程已结束|已结束课程|课程结束|已关闭|已归档)/.test(`${task.course || ""} ${task.capturedText || ""}`)) return false;
  return Boolean(task.dueAt);
}

function isValidTaskTitle(title) {
  const normalized = String(title || "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (/^(id|courseStyle|style|type|name|title|content|chapterId|lessonId)\b/i.test(normalized)) return false;
  if (/\b(courseStyle|chapterId|lessonId|contentId|categoryId|termId)\b/i.test(normalized)) return false;
  if (/^[\w-]+\s*[:：]/.test(normalized) && !/(作业|互评|测验|测试|考试|讨论|问卷)/.test(normalized)) return false;
  if (/^[\d\s()[\]（）-]+$/.test(normalized)) return false;
  return true;
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}
