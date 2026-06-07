const TASK_KEYWORDS = [
  "作业",
  "互评",
  "测验",
  "考试",
  "测试",
  "讨论",
  "问卷",
  "提交",
  "未提交",
  "待完成",
  "未完成",
  "截止"
];

const DONE_KEYWORDS = ["已完成", "已提交", "已交", "完成学习", "得分", "已评分"];
const MAX_TEXT_LENGTH = 180;

let scanTimer = null;

scanSoon();
observePageChanges();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MOOC_SCAN_NOW") {
    const tasks = collectTasks();
    chrome.runtime.sendMessage({ type: "MOOC_TASKS_FOUND", tasks });
    sendResponse({ ok: true, count: tasks.length });
    return true;
  }

  return false;
});

function observePageChanges() {
  const observer = new MutationObserver(() => scanSoon());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scanSoon() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanPage, 800);
}

function scanPage() {
  const tasks = collectTasks();
  chrome.runtime.sendMessage({
    type: "MOOC_TASKS_FOUND",
    tasks
  });
}

function collectTasks() {
  const candidates = new Map();
  const selectors = [
    "a",
    "li",
    "[class*='homework']",
    "[class*='quiz']",
    "[class*='exam']",
    "[class*='task']",
    "[class*='assignment']",
    "[class*='j-task']",
    "[data-name]",
    "[title]"
  ];

  for (const element of document.querySelectorAll(selectors.join(","))) {
    if (!isVisible(element)) continue;

    const container = closestMeaningfulContainer(element);
    const text = normalizeText(container.innerText || element.innerText || element.textContent || "");
    if (!looksLikeTask(text)) continue;

    const title = extractTitle(container, text);
    if (!title) continue;

    const dueAt = extractDueAt(text);
    const status = getStatus(text);
    const link = container.querySelector("a[href]") || element.closest("a[href]") || element.querySelector?.("a[href]");
    const pageUrl = link ? new URL(link.getAttribute("href"), location.href).href : location.href;
    const course = extractCourseName();
    const id = makeTaskId(title, course, dueAt, pageUrl);

    candidates.set(id, {
      id,
      title,
      course,
      type: inferTaskType(text),
      status,
      done: status === "done",
      dueAt,
      pageUrl,
      capturedText: text.slice(0, MAX_TEXT_LENGTH),
      foundAt: Date.now()
    });
  }

  return Array.from(candidates.values())
    .filter((task) => task.status !== "done" || task.dueAt)
    .slice(0, 80);
}

function closestMeaningfulContainer(element) {
  const container = element.closest("li, tr, [class*='item'], [class*='card'], [class*='unit'], [class*='task'], [class*='lesson']");
  return container || element;
}

function looksLikeTask(text) {
  if (text.length < 3 || text.length > 700) return false;
  const hasTaskWord = TASK_KEYWORDS.some((keyword) => text.includes(keyword));
  const hasActionableState = /(未完成|待完成|未提交|提交|截止|剩余|开始|进行中)/.test(text);
  return hasTaskWord && hasActionableState;
}

function extractTitle(container, text) {
  const titleAttr = container.getAttribute("title") || container.querySelector("[title]")?.getAttribute("title");
  const heading = container.querySelector("h1,h2,h3,h4,[class*='title'],[class*='name']")?.innerText;
  const linkText = container.querySelector("a")?.innerText;
  const raw = titleAttr || heading || linkText || text;

  return normalizeText(raw)
    .replace(/^(作业|测验|考试|讨论|问卷)[:：\s]*/, "")
    .split(/截止|状态|未提交|待完成|已提交|已完成|进入|查看/)[0]
    .slice(0, 80)
    .trim();
}

function extractCourseName() {
  const selectors = [
    ".course-title",
    "[class*='courseName']",
    "[class*='course-name']",
    "[class*='course_title']",
    "h1"
  ];

  for (const selector of selectors) {
    const text = normalizeText(document.querySelector(selector)?.innerText || "");
    if (text && text.length < 80) return text;
  }

  return normalizeText(document.title)
    .replace(/中国大学MOOC|中国大学 MOOC|慕课/gi, "")
    .replace(/[-_|]/g, " ")
    .trim();
}

function extractDueAt(text) {
  const now = new Date();
  const patterns = [
    /(?:截止|截至|结束|提交截止|截止时间)[:：\s]*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/,
    /(?:截止|截至|结束|提交截止|截止时间)[:：\s]*(\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/,
    /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/,
    /(\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const hasYear = match[1]?.length === 4;
    const year = hasYear ? Number(match[1]) : now.getFullYear();
    const month = Number(hasYear ? match[2] : match[1]);
    const day = Number(hasYear ? match[3] : match[2]);
    const hour = Number(hasYear ? match[4] || 23 : match[3] || 23);
    const minute = Number(hasYear ? match[5] || 59 : match[4] || 59);
    const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return null;
}

function getStatus(text) {
  if (DONE_KEYWORDS.some((keyword) => text.includes(keyword))) return "done";
  if (/已截止|已结束|过期/.test(text)) return "overdue";
  if (/未完成|未提交|待完成|进行中|提交/.test(text)) return "todo";
  return "unknown";
}

function inferTaskType(text) {
  if (text.includes("互评")) return "互评";
  if (text.includes("作业")) return "作业";
  if (text.includes("测验") || text.includes("测试")) return "测验";
  if (text.includes("考试")) return "考试";
  if (text.includes("讨论")) return "讨论";
  if (text.includes("问卷")) return "问卷";
  return "任务";
}

function makeTaskId(title, course, dueAt, pageUrl) {
  return simpleHash([course, title, dueAt || "", pageUrl.split("#")[0]].join("|"));
}

function simpleHash(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return `task-${Math.abs(hash)}`;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}
