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
  "未交",
  "待提交",
  "待互评",
  "待完成",
  "未完成",
  "截止",
  "截至",
  "截止时间"
];

const DONE_KEYWORDS = ["已完成", "已提交", "已交", "完成学习", "得分", "已评分", "已批改"];
const MAX_TEXT_LENGTH = 180;
const MAX_LINKED_COURSES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 370 * DAY_MS;

let scanTimer = null;

scanSoon();
observePageChanges();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MOOC_SCAN_NOW") {
    scanPage().then((tasks) => sendResponse({ ok: true, count: tasks.length }));
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

async function scanPage() {
  const tasks = await collectTasks();
  chrome.runtime.sendMessage({
    type: "MOOC_TASKS_FOUND",
    tasks
  });
  return tasks;
}

async function collectTasks() {
  const ownTasks = collectTasksFromRoot(document, location.href, extractCourseName(document));
  const linkedTasks = await collectTasksFromLinkedCourses();
  return mergeTasks([...ownTasks, ...linkedTasks]).slice(0, 160);
}

function collectTasksFromRoot(root, baseUrl, fallbackCourse) {
  if (isEndedCoursePage(root)) return [];

  const candidates = new Map();
  collectElementTasks(root, baseUrl, fallbackCourse, candidates, true);
  collectScriptTasks(root, baseUrl, fallbackCourse, candidates);

  if (candidates.size === 0) {
    collectElementTasks(root, baseUrl, fallbackCourse, candidates, false);
  }

  return Array.from(candidates.values())
    .filter((task) => task.status !== "done" || task.dueAt)
    .slice(0, 80);
}

function collectElementTasks(root, baseUrl, fallbackCourse, candidates, strictMode) {
  const selectors = [
    "a",
    "li",
    "tr",
    "button",
    "[class*='homework']",
    "[class*='work']",
    "[class*='quiz']",
    "[class*='test']",
    "[class*='exam']",
    "[class*='task']",
    "[class*='todo']",
    "[class*='assignment']",
    "[class*='j-task']",
    "[data-name]",
    "[title]"
  ];

  for (const element of root.querySelectorAll(selectors.join(","))) {
    if (root === document && !isVisible(element)) continue;

    const container = closestMeaningfulContainer(element);
    const text = normalizeText(container.innerText || element.innerText || element.textContent || "");
    if (isEndedCourseText(text)) continue;
    if (!looksLikeTask(text)) continue;

    const title = extractTitle(container, text);
    if (!title) continue;

    const dueAt = extractDueAt(text);
    const status = getStatus(text);
    if (!isAccurateTaskCandidate(text, title, dueAt, status, strictMode, container)) continue;

    const link = container.querySelector("a[href]") || element.closest("a[href]") || element.querySelector?.("a[href]");
    const pageUrl = link ? new URL(link.getAttribute("href"), baseUrl).href : baseUrl;
    const course = extractCourseName(root) || fallbackCourse || "中国大学 MOOC";
    const id = makeTaskId(title, course, dueAt, pageUrl);

    candidates.set(id, {
      id,
      title,
      course,
      type: inferTaskType(text),
      status,
      done: status === "done",
      dueAt,
      priority: getPriority(dueAt, status),
      confidence: strictMode ? "high" : "medium",
      pageUrl,
      capturedText: text.slice(0, MAX_TEXT_LENGTH),
      foundAt: Date.now()
    });
  }
}

function collectScriptTasks(root, baseUrl, fallbackCourse, candidates) {
  for (const script of root.querySelectorAll("script")) {
    const text = script.textContent || "";
    if (!/(作业|互评|测验|测试|考试|讨论|问卷|homework|quiz|exam|assignment|deadline|endTime|closeTime)/i.test(text)) {
      continue;
    }

    for (const task of extractTasksFromSerializedText(text, baseUrl, fallbackCourse)) {
      candidates.set(task.id, task);
    }
  }
}

function extractTasksFromSerializedText(text, baseUrl, fallbackCourse) {
  const tasks = [];
  const normalized = decodeSerializedText(text).replace(/\\\//g, "/");
  const chunks = normalized.match(/.{0,120}(?:作业|互评|测验|测试|考试|讨论|问卷|homework|quiz|exam|assignment).{0,260}/gi) || [];

  for (const chunk of chunks.slice(0, 80)) {
    if (isEndedCourseText(chunk)) continue;

    const cleanChunk = normalizeText(chunk.replace(/[{}[\]",]/g, " "));
    const dueAt = extractDueAt(cleanChunk) || extractTimestampDeadline(chunk);
    if (!dueAt) continue;

    const status = getStatus(cleanChunk);
    if (!isAccurateTaskCandidate(cleanChunk, cleanChunk, dueAt, status, false, null)) continue;

    const title = extractSerializedTitle(chunk);
    if (!isValidTaskTitle(title)) continue;

    const urlMatch = chunk.match(/https?:\/\/[^"'\\\s]+|\/(?:learn|course|spoc|term)\/[^"'\\\s]+/i);
    const pageUrl = urlMatch ? new URL(urlMatch[0], baseUrl).href : baseUrl;
    const course = fallbackCourse || "中国大学 MOOC";
    const id = makeTaskId(title, course, dueAt, pageUrl);

    tasks.push({
      id,
      title,
      course,
      type: inferTaskType(cleanChunk),
      status,
      done: status === "done",
      dueAt,
      priority: getPriority(dueAt, status),
      confidence: "medium",
      pageUrl,
      capturedText: cleanChunk.slice(0, MAX_TEXT_LENGTH),
      foundAt: Date.now()
    });
  }

  return tasks;
}

async function collectTasksFromLinkedCourses() {
  const courseLinks = findCourseLinks();
  if (courseLinks.length === 0) return [];

  const allTasks = [];
  for (const course of courseLinks.slice(0, MAX_LINKED_COURSES)) {
    const html = await fetchCourseHtml(course.url);
    if (!html) continue;

    const page = new DOMParser().parseFromString(html, "text/html");
    if (isEndedCoursePage(page)) continue;

    const courseName = extractCourseName(page) || course.title;
    allTasks.push(...collectTasksFromRoot(page, course.url, courseName));

    const subPages = findTaskPageLinks(page, course.url).slice(0, 8);
    for (const subPageUrl of subPages) {
      const subHtml = await fetchCourseHtml(subPageUrl);
      if (!subHtml) continue;
      const subPage = new DOMParser().parseFromString(subHtml, "text/html");
      allTasks.push(...collectTasksFromRoot(subPage, subPageUrl, courseName));
    }
  }

  return mergeTasks(allTasks);
}

function findCourseLinks() {
  const links = [];
  const seen = new Set();

  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;

    const url = new URL(href, location.href);
    if (!isMoocUrl(url) || !looksLikeCourseUrl(url.href)) continue;

    const container = anchor.closest("li, [class*='course'], [class*='card'], [class*='item']") || anchor;
    const containerText = normalizeText(container.innerText || container.textContent || "");
    if (isEndedCourseText(containerText)) continue;

    const title = normalizeText(
      anchor.getAttribute("title") ||
        container.querySelector("[title]")?.getAttribute("title") ||
        anchor.innerText ||
        container.innerText ||
        ""
    )
      .split(/进行中|已结束|开课|学习|进入/)[0]
      .slice(0, 80)
      .trim();

    const normalizedUrl = url.href.split("#")[0];
    if (!title || seen.has(normalizedUrl)) continue;

    seen.add(normalizedUrl);
    links.push({ url: normalizedUrl, title });
  }

  return links;
}

function findTaskPageLinks(root, baseUrl) {
  const urls = [];
  const seen = new Set();

  for (const anchor of root.querySelectorAll("a[href]")) {
    const text = normalizeText(anchor.innerText || anchor.textContent || anchor.getAttribute("title") || "");
    const url = new URL(anchor.getAttribute("href"), baseUrl);
    if (!isMoocUrl(url)) continue;
    if (!/(作业|测验|测试|考试|讨论|问卷|任务|homework|quiz|exam|test|forum|task)/i.test(text + url.href)) continue;

    const normalizedUrl = url.href.split("#")[0];
    if (seen.has(normalizedUrl)) continue;

    seen.add(normalizedUrl);
    urls.push(normalizedUrl);
  }

  return urls;
}

async function fetchCourseHtml(url) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "MOOC_FETCH_HTML",
      url
    });
    return response?.html || "";
  } catch (_error) {
    return "";
  }
}

function closestMeaningfulContainer(element) {
  const container = element.closest("li, tr, [class*='item'], [class*='card'], [class*='unit'], [class*='task'], [class*='lesson']");
  return container || element;
}

function looksLikeTask(text) {
  if (text.length < 3 || text.length > 700) return false;
  const hasTaskWord = TASK_KEYWORDS.some((keyword) => text.includes(keyword));
  const hasActionableState = /(未完成|待完成|未提交|未交|待提交|提交|截止|截至|截止时间|即将截止|剩余|开始|进行中|待互评|开放)/.test(text);
  return hasTaskWord && hasActionableState;
}

function isAccurateTaskCandidate(text, title, dueAt, status, strictMode, container) {
  if (!isValidTaskTitle(title)) return false;
  if (/课程介绍|课程大纲|评分标准|公告|通知|老师|讲师|证书/.test(title)) return false;
  if (/已完成|已提交|已评分|已批改/.test(text) && !/未完成|未提交|未交|待提交|待完成|待互评/.test(text)) return false;

  const hasSpecificTaskWord = /(作业|互评|测验|测试|考试|讨论|问卷)/.test(text);
  const hasPendingState = /(未完成|待完成|未提交|未交|待提交|待互评|进行中|未开始)/.test(text);
  const hasDueSignal = Boolean(dueAt) || /(截止|截至|截止时间|即将截止|剩余\s*\d+)/.test(text);
  const href = container?.querySelector?.("a[href]")?.getAttribute("href") || container?.closest?.("a[href]")?.getAttribute("href") || "";
  const hasTaskUrl = /(homework|quiz|exam|test|forum|hw|task|work)/i.test(href);

  if (strictMode) {
    return hasSpecificTaskWord && (hasPendingState || hasDueSignal || status === "overdue");
  }

  return hasSpecificTaskWord && (hasPendingState || hasDueSignal || hasTaskUrl);
}

function extractTitle(container, text) {
  const titleAttr = container.getAttribute("title") || container.querySelector("[title]")?.getAttribute("title");
  const headingElement = container.querySelector("h1,h2,h3,h4,[class*='title'],[class*='name']");
  const heading = headingElement?.innerText || headingElement?.textContent;
  const link = container.querySelector("a");
  const linkText = link?.innerText || link?.textContent;
  const raw = titleAttr || heading || linkText || text;

  return normalizeText(raw)
    .replace(/^(作业|测验|考试|讨论|问卷)[:：\s]*/, "")
    .split(/截止|截至|截止时间|状态|未提交|未交|待提交|待完成|已提交|已完成|进入|查看/)[0]
    .slice(0, 80)
    .trim();
}

function extractCourseName(root = document) {
  const selectors = [
    ".course-title",
    "[class*='courseName']",
    "[class*='course-name']",
    "[class*='course_title']",
    "h1"
  ];

  for (const selector of selectors) {
    const element = root.querySelector(selector);
    const text = normalizeText(element?.innerText || element?.textContent || "");
    if (text && text.length < 80) return text;
  }

  return normalizeText(root.title || document.title)
    .replace(/中国大学MOOC|中国大学 MOOC|慕课/gi, "")
    .replace(/[-_|]/g, " ")
    .trim();
}

function extractDueAt(text) {
  const now = new Date();
  const patterns = [
    {
      kind: "year",
      regex: /(?:截止|截至|结束|提交截止|截止时间)[:：\s]*(\d{4})[./-](\d{1,2})[./-](\d{1,2})\s*(\d{1,2})?[:：](\d{1,2})(?::\d{1,2})?/
    },
    {
      kind: "year",
      regex: /(?:截止|截至|结束|提交截止|截止时间)[:：\s]*(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/
    },
    {
      kind: "month",
      regex: /(?:截止|截至|结束|提交截止|截止时间)[:：\s]*(\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/
    },
    {
      kind: "day",
      regex: /(?:截止|截至|结束|提交截止|截止时间)[:：\s]*(\d{1,2})日\s*(\d{1,2})?[:：点]?(\d{1,2})?/
    },
    {
      kind: "year",
      regex: /(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/
    },
    {
      kind: "month",
      regex: /(\d{1,2})[月/-](\d{1,2})日?\s*(\d{1,2})?[:：点]?(\d{1,2})?/
    }
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;

    const year = pattern.kind === "year" ? Number(match[1]) : now.getFullYear();
    const month = pattern.kind === "day" ? now.getMonth() + 1 : Number(pattern.kind === "year" ? match[2] : match[1]);
    const day = pattern.kind === "day" ? Number(match[1]) : Number(pattern.kind === "year" ? match[3] : match[2]);
    const hour = Number(pattern.kind === "day" ? match[2] || 23 : pattern.kind === "year" ? match[4] || 23 : match[3] || 23);
    const minute = Number(pattern.kind === "day" ? match[3] || 59 : pattern.kind === "year" ? match[5] || 59 : match[4] || 59);
    if (!isDatePartValid(year, month, day, hour, minute)) continue;

    const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) continue;

    if (pattern.kind !== "year" && parsed.getTime() < now.getTime() - DAY_MS) {
      parsed.setFullYear(parsed.getFullYear() + 1);
    }

    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime() + MAX_FUTURE_MS) {
      return parsed.getTime();
    }
  }

  return null;
}

function getStatus(text) {
  if (DONE_KEYWORDS.some((keyword) => text.includes(keyword))) return "done";
  if (/已截止|已结束|过期/.test(text)) return "overdue";
  if (/未完成|未提交|未交|待提交|待完成|待互评|进行中|提交/.test(text)) return "todo";
  return "unknown";
}

function getPriority(dueAt, status) {
  if (status === "overdue") return "overdue";
  if (!dueAt) return "unknown";

  const diff = dueAt - Date.now();
  if (diff < 0) return "overdue";
  if (diff <= DAY_MS) return "day";
  if (diff <= 7 * DAY_MS) return "week";
  if (diff <= 30 * DAY_MS) return "month";
  return "later";
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

function mergeTasks(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    byId.set(task.id, { ...byId.get(task.id), ...task });
  }
  return Array.from(byId.values());
}

function looksLikeCourseUrl(url) {
  return /\/course\/|\/learn\/|\/spoc\/|\/term\/|courseId=|tid=/.test(url);
}

function isMoocUrl(url) {
  return /(^|\.)icourse163\.org$|(^|\.)universitymooc\.com$/.test(url.hostname);
}

function simpleHash(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return `task-${Math.abs(hash)}`;
}

function decodeSerializedText(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractTimestampDeadline(text) {
  const match = text.match(/(?:deadline|endTime|closeTime|dueTime|endDate|截止时间)["':\s]*(\d{10,13})/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return value < 100000000000 ? value * 1000 : value;
}

function extractSerializedTitle(text) {
  const decoded = decodeSerializedText(text).replace(/\\"/g, '"');
  const explicit = decoded.match(/["'](?:title|name|homeworkName|quizName|examName|assignmentName|testName)["']\s*:\s*["']([^"']{2,80})["']/i);
  const raw = explicit?.[1] || "";
  return normalizeText(raw)
    .split(/截止|截至|截止时间|未提交|未交|待提交|待完成|已提交|已完成|进入|查看|deadline|endTime/i)[0]
    .slice(0, 80)
    .trim();
}

function isValidTaskTitle(title) {
  const normalized = normalizeText(title);
  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (/^(id|courseStyle|style|type|name|title|content|chapterId|lessonId)\b/i.test(normalized)) return false;
  if (/\b(courseStyle|chapterId|lessonId|contentId|categoryId|termId)\b/i.test(normalized)) return false;
  if (/^[\w-]+\s*[:：]/.test(normalized) && !/(作业|互评|测验|测试|考试|讨论|问卷)/.test(normalized)) return false;
  if (/^[\d\s()[\]（）-]+$/.test(normalized)) return false;
  return true;
}

function isDatePartValid(year, month, day, hour, minute) {
  return (
    year >= 2020 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

function isEndedCoursePage(root) {
  const bodyText = normalizeText(root.body?.innerText || root.body?.textContent || "");
  return isEndedCourseText(bodyText) && !/(未完成|未提交|未交|待提交|待互评|待完成)/.test(bodyText);
}

function isEndedCourseText(text) {
  return /(已结课|课程已结束|已结束课程|课程结束|已关闭|已归档)/.test(text);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}
