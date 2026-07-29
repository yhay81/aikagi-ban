const sessionKey = "aikagi-ban-session";
const firstDayKey = "aikagi-ban-first-day";
const form = document.querySelector("[data-create-form]");
const state = document.querySelector("[data-create-state]");
const qa = new URLSearchParams(location.search).get("qa") === "1" || navigator.webdriver === true;

const dayInJst = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const getSession = () => {
  let session = localStorage.getItem(sessionKey);
  if (!session) {
    session = crypto.randomUUID();
    localStorage.setItem(sessionKey, session);
  }
  return session;
};

const showState = (message, tone = "") => {
  if (!(state instanceof HTMLElement)) return;
  state.textContent = message;
  state.dataset.tone = tone;
};

const sendEvent = async (name) => {
  try {
    await fetch("/api/events", {
      body: JSON.stringify({ boardId: null, name }),
      headers: {
        "content-type": "application/json",
        "x-aikagi-qa": qa ? "1" : "0",
        "x-aikagi-session": getSession(),
      },
      method: "POST",
    });
  } catch {
    // The creation flow continues when anonymous metrics are unavailable.
  }
};

const sendEventOnce = (name) => {
  const marker = `aikagi-ban-event-${name}-${dayInJst()}`;
  if (sessionStorage.getItem(marker)) return;
  sessionStorage.setItem(marker, "1");
  void sendEvent(name);
};

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(form instanceof HTMLFormElement)) return;
  const submit = form.querySelector('button[type="submit"]');
  if (submit instanceof HTMLButtonElement) submit.disabled = true;
  showState("合い鍵を削り出しています…", "working");
  const values = new FormData(form);
  try {
    const response = await fetch("/api/boards", {
      body: JSON.stringify({
        description: values.get("description"),
        title: values.get("title"),
      }),
      headers: {
        "content-type": "application/json",
        "x-aikagi-qa": qa ? "1" : "0",
        "x-aikagi-session": getSession(),
      },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload.error === "create_rate_limited" ? "今日は3枚まで作れます" : "板を作れませんでした",
      );
    }
    sessionStorage.setItem(`aikagi-manage-url-${payload.id}`, payload.manageUrl);
    location.href = payload.manageUrl;
  } catch (error) {
    showState(error instanceof Error ? error.message : "板を作れませんでした", "error");
    if (submit instanceof HTMLButtonElement) submit.disabled = false;
  }
});

const today = dayInJst();
const firstDay = localStorage.getItem(firstDayKey);
if (!firstDay) {
  localStorage.setItem(firstDayKey, today);
} else if (firstDay !== today) {
  sendEventOnce("returned");
}
sendEventOnce("visited");
