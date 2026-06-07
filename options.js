const DEFAULT_SETTINGS = {
  reminderHours: 24,
  scanIntervalMinutes: 30,
  notifyEnabled: true
};

const reminderHours = document.querySelector("#reminderHours");
const scanIntervalMinutes = document.querySelector("#scanIntervalMinutes");
const notifyEnabled = document.querySelector("#notifyEnabled");
const saveSettings = document.querySelector("#saveSettings");
const saveState = document.querySelector("#saveState");

document.addEventListener("DOMContentLoaded", loadSettings);
saveSettings.addEventListener("click", storeSettings);

async function loadSettings() {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  reminderHours.value = settings.reminderHours;
  scanIntervalMinutes.value = settings.scanIntervalMinutes;
  notifyEnabled.checked = settings.notifyEnabled;
}

async function storeSettings() {
  const settings = {
    reminderHours: Math.max(1, Number(reminderHours.value) || DEFAULT_SETTINGS.reminderHours),
    scanIntervalMinutes: Math.max(5, Number(scanIntervalMinutes.value) || DEFAULT_SETTINGS.scanIntervalMinutes),
    notifyEnabled: notifyEnabled.checked
  };

  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({ type: "MOOC_REFRESH_ALARM" });
  saveState.textContent = "已保存";
  setTimeout(() => {
    saveState.textContent = "";
  }, 1600);
}
