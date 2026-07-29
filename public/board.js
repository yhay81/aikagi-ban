const shell = document.querySelector("[data-board-id]");
const boardId = shell?.getAttribute("data-board-id") ?? "";
const sessionKey = "aikagi-ban-session";
const displayNameKey = "aikagi-ban-display-name";
const qa = new URLSearchParams(location.search).get("qa") === "1" || navigator.webdriver === true;
const fragment = new URLSearchParams(location.hash.slice(1));
let accessKey = fragment.get("key") ?? sessionStorage.getItem(`aikagi-key-${boardId}`) ?? "";
let manageKey = fragment.get("manage") ?? sessionStorage.getItem(`aikagi-manage-${boardId}`) ?? "";
let boardState = null;
let activeKind = "all";
let searchTerm = "";
let loading = false;
const photoUrls = new Map();

const getSession = () => {
  let session = localStorage.getItem(sessionKey);
  if (!session) {
    session = crypto.randomUUID();
    localStorage.setItem(sessionKey, session);
  }
  return session;
};

if (accessKey) sessionStorage.setItem(`aikagi-key-${boardId}`, accessKey);
if (manageKey) sessionStorage.setItem(`aikagi-manage-${boardId}`, manageKey);
if (location.hash) history.replaceState(null, "", location.pathname);

const headers = (json = false) => ({
  ...(json ? { "content-type": "application/json" } : {}),
  "x-aikagi-key": accessKey,
  "x-aikagi-manage": manageKey,
  "x-aikagi-qa": qa ? "1" : "0",
  "x-aikagi-session": getSession(),
});

const messages = {
  board_expired: "この板は30日の期限を迎えました。",
  board_full: "この板はいっぱいです。",
  create_rate_limited: "本日の上限に達しました。",
  invalid_key: "合い鍵が合いません。共有されたURLを確認してください。",
  invalid_photo: "写真を読み込めません。別の写真を選んでください。",
  invalid_text: "文字数を確認してください。",
  organizer_required: "管理用URLから開いてください。",
  rate_limited: "本日の投稿上限に達しました。",
};

const errorMessage = async (response) => {
  try {
    const payload = await response.json();
    return messages[payload.error] ?? "操作を完了できませんでした。";
  } catch {
    return "操作を完了できませんでした。";
  }
};

const setStatus = (message, tone = "") => {
  const status = document.querySelector("[data-board-status]");
  if (!(status instanceof HTMLElement)) return;
  status.dataset.tone = tone;
  const label = status.querySelector("span");
  if (label) label.textContent = message;
};

const setComposerState = (message, tone = "") => {
  const node = document.querySelector("[data-composer-state]");
  if (!(node instanceof HTMLElement)) return;
  node.textContent = message;
  node.dataset.tone = tone;
};

const dateLabel = (timestamp) =>
  new Intl.DateTimeFormat("ja-JP", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp * 1000));

const expiryLabel = (timestamp) => {
  const days = Math.max(0, Math.ceil((timestamp * 1000 - Date.now()) / 86_400_000));
  return `あと ${days}日`;
};

const rememberName = (value) => {
  const name = value.trim().slice(0, 24);
  if (name) localStorage.setItem(displayNameKey, name);
  return name;
};

const currentName = () => {
  const postName = document.querySelector('[data-post-form] [name="displayName"]');
  if (postName instanceof HTMLInputElement && postName.value.trim()) {
    return rememberName(postName.value);
  }
  return localStorage.getItem(displayNameKey) ?? "";
};

const requireName = () => {
  const saved = currentName();
  if (saved) return saved;
  const entered = prompt("板に表示する名前を入力してください（24文字まで）", "")?.trim() ?? "";
  if (!entered || entered.length > 24) return "";
  return rememberName(entered);
};

const sendEventOnce = async (name) => {
  const marker = `aikagi-ban-board-event-${name}-${boardId}`;
  if (sessionStorage.getItem(marker)) return;
  sessionStorage.setItem(marker, "1");
  try {
    await fetch("/api/events", {
      body: JSON.stringify({ boardId, name }),
      headers: headers(true),
      method: "POST",
    });
  } catch {
    // Board use continues when anonymous metrics are unavailable.
  }
};

const fetchPhoto = async (postId, image, wrapper) => {
  if (photoUrls.has(postId)) {
    image.src = photoUrls.get(postId);
    wrapper.classList.add("ready");
    return;
  }
  try {
    const response = await fetch(`/api/boards/${boardId}/posts/${postId}/photo`, {
      headers: headers(),
    });
    if (!response.ok) throw new Error("photo_failed");
    const url = URL.createObjectURL(await response.blob());
    photoUrls.set(postId, url);
    image.src = url;
    wrapper.classList.add("ready");
  } catch {
    wrapper.hidden = true;
  }
};

const patchPost = async (postId, pinned) => {
  const response = await fetch(`/api/boards/${boardId}/posts/${postId}`, {
    body: JSON.stringify({ pinned }),
    headers: headers(true),
    method: "PATCH",
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  await loadBoard();
};

const deletePost = async (postId) => {
  if (!confirm("この投稿と返信・確認印を削除しますか？")) return;
  const response = await fetch(`/api/boards/${boardId}/posts/${postId}`, {
    headers: headers(),
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const url = photoUrls.get(postId);
  if (url) URL.revokeObjectURL(url);
  photoUrls.delete(postId);
  await loadBoard();
};

const toggleAck = async (post) => {
  if (post.acknowledged) {
    const response = await fetch(`/api/boards/${boardId}/posts/${post.id}/ack`, {
      headers: headers(),
      method: "DELETE",
    });
    if (!response.ok) throw new Error(await errorMessage(response));
  } else {
    const displayName = requireName();
    if (!displayName) return;
    const response = await fetch(`/api/boards/${boardId}/posts/${post.id}/ack`, {
      body: JSON.stringify({ displayName }),
      headers: headers(true),
      method: "PUT",
    });
    if (!response.ok) throw new Error(await errorMessage(response));
  }
  await loadBoard();
};

const postMatches = (post) => {
  if (activeKind !== "all" && post.kind !== activeKind) return false;
  if (!searchTerm) return true;
  const haystack = [
    post.displayName,
    post.title,
    post.body,
    ...post.comments.flatMap((comment) => [comment.display_name, comment.body]),
  ]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase("ja");
  return haystack.includes(searchTerm);
};

const renderPosts = () => {
  if (!boardState) return;
  const grid = document.querySelector("[data-post-grid]");
  const postTemplate = document.querySelector("#post-template");
  const commentTemplate = document.querySelector("#comment-template");
  if (
    !(grid instanceof HTMLElement) ||
    !(postTemplate instanceof HTMLTemplateElement) ||
    !(commentTemplate instanceof HTMLTemplateElement)
  ) {
    return;
  }
  grid.replaceChildren();
  const posts = boardState.posts.filter(postMatches);
  for (const post of posts) {
    const fragmentNode = postTemplate.content.cloneNode(true);
    const card = fragmentNode.querySelector(".board-post");
    if (!(card instanceof HTMLElement)) continue;
    card.dataset.kind = post.kind;
    card.classList.toggle("pinned", post.isPinned);
    const kindLabels = { notice: "お知らせ", note: "メモ", question: "質問" };
    const setText = (selector, value) => {
      const node = card.querySelector(selector);
      if (node) node.textContent = value;
    };
    setText("[data-post-kind]", kindLabels[post.kind]);
    setText("[data-post-time]", `${post.displayName} · ${dateLabel(post.createdAt)}`);
    setText("[data-post-title]", post.title);
    setText("[data-post-body]", post.body);
    setText("[data-ack-count]", String(post.acknowledgements.length));

    const acknowledgementNames = card.querySelector("[data-ack-names]");
    if (acknowledgementNames instanceof HTMLElement) {
      acknowledgementNames.replaceChildren(
        ...post.acknowledgements.slice(0, 5).map((acknowledgement) => {
          const name = document.createElement("span");
          name.textContent = acknowledgement.displayName.slice(0, 1);
          name.title = acknowledgement.displayName;
          return name;
        }),
      );
      if (post.acknowledgements.length > 5) {
        const more = document.createElement("small");
        more.textContent = `+${post.acknowledgements.length - 5}`;
        acknowledgementNames.append(more);
      }
    }
    const ack = card.querySelector('[data-post-action="ack"]');
    if (ack instanceof HTMLButtonElement) {
      ack.classList.toggle("active", post.acknowledged);
      ack.addEventListener("click", () => {
        void toggleAck(post).catch((error) =>
          setStatus(error instanceof Error ? error.message : "確認印を変更できません", "error"),
        );
      });
    }

    const photoWrapper = card.querySelector("[data-post-photo-wrap]");
    const photo = card.querySelector("[data-post-photo]");
    if (post.hasPhoto && photoWrapper instanceof HTMLElement && photo instanceof HTMLImageElement) {
      photoWrapper.hidden = false;
      void fetchPhoto(post.id, photo, photoWrapper);
    }

    const comments = card.querySelector("[data-comments]");
    if (comments instanceof HTMLElement) {
      for (const comment of post.comments) {
        const commentFragment = commentTemplate.content.cloneNode(true);
        const name = commentFragment.querySelector("[data-comment-name]");
        const body = commentFragment.querySelector("[data-comment-body]");
        const time = commentFragment.querySelector("[data-comment-time]");
        if (name) name.textContent = comment.display_name;
        if (body) body.textContent = comment.body;
        if (time) time.textContent = dateLabel(comment.created_at);
        comments.append(commentFragment);
      }
    }
    const commentForm = card.querySelector("[data-comment-form]");
    if (commentForm instanceof HTMLFormElement) {
      const nameInput = commentForm.elements.namedItem("displayName");
      if (nameInput instanceof HTMLInputElement) nameInput.value = currentName();
      commentForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = new FormData(commentForm);
        const displayName = rememberName(String(values.get("displayName") ?? ""));
        const body = String(values.get("body") ?? "").trim();
        if (!displayName || !body) return;
        const button = commentForm.querySelector("button");
        if (button instanceof HTMLButtonElement) button.disabled = true;
        try {
          const response = await fetch(`/api/boards/${boardId}/posts/${post.id}/comments`, {
            body: JSON.stringify({ body, displayName }),
            headers: headers(true),
            method: "POST",
          });
          if (!response.ok) throw new Error(await errorMessage(response));
          await loadBoard();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "返信できませんでした", "error");
          if (button instanceof HTMLButtonElement) button.disabled = false;
        }
      });
    }

    const organizerActions = card.querySelector("[data-organizer-actions]");
    if (organizerActions instanceof HTMLElement && boardState.isOrganizer) {
      organizerActions.hidden = false;
      const pin = organizerActions.querySelector('[data-post-action="pin"]');
      if (pin instanceof HTMLButtonElement) {
        pin.textContent = post.isPinned ? "固定を外す" : "上へ固定";
        pin.addEventListener("click", () => {
          void patchPost(post.id, !post.isPinned).catch((error) =>
            setStatus(error instanceof Error ? error.message : "固定を変更できません", "error"),
          );
        });
      }
      organizerActions
        .querySelector('[data-post-action="delete"]')
        ?.addEventListener("click", () => {
          void deletePost(post.id).catch((error) =>
            setStatus(error instanceof Error ? error.message : "削除できません", "error"),
          );
        });
    }
    grid.append(fragmentNode);
  }
  const empty = document.querySelector("[data-empty-board]");
  if (empty instanceof HTMLElement) empty.hidden = posts.length !== 0;
};

const renderBoard = () => {
  if (!boardState) return;
  const { board } = boardState;
  const setText = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };
  setText("[data-board-title]", board.title);
  setText("[data-board-description]", board.description || "合い鍵を知る人だけの連絡板");
  setText("[data-expiry-badge]", expiryLabel(board.expiresAt));
  setText("[data-post-count]", String(board.postCount));
  setText("[data-comment-count]", String(board.commentCount));
  const names = new Set(
    boardState.posts.flatMap((post) => [
      post.displayName,
      ...post.comments.map((comment) => comment.display_name),
      ...post.acknowledgements.map((acknowledgement) => acknowledgement.displayName),
    ]),
  );
  setText("[data-member-count]", String(names.size));
  document.querySelectorAll("[data-organizer-only]").forEach((node) => {
    if (node instanceof HTMLElement) node.hidden = !boardState.isOrganizer;
  });
  const rememberedName = localStorage.getItem(displayNameKey) ?? "";
  document.querySelectorAll('[name="displayName"]').forEach((node) => {
    if (node instanceof HTMLInputElement && !node.value) node.value = rememberedName;
  });
  renderPosts();
};

const loadBoard = async () => {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch(`/api/boards/${boardId}`, { headers: headers() });
    if (!response.ok) throw new Error(await errorMessage(response));
    boardState = await response.json();
    const locked = document.querySelector("[data-locked-board]");
    const application = document.querySelector("[data-board-app]");
    if (locked instanceof HTMLElement) locked.hidden = true;
    if (application instanceof HTMLElement) application.hidden = false;
    setStatus("最新の板です", "ready");
    renderBoard();
    void sendEventOnce("board_opened");
  } catch (error) {
    const message = error instanceof Error ? error.message : "板を開けませんでした";
    const lockMessage = document.querySelector("[data-lock-message]");
    if (lockMessage) lockMessage.textContent = message;
    setStatus(message, "error");
  } finally {
    loading = false;
  }
};

const blobFromCanvas = (canvas, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("写真を縮小できません"))),
      "image/jpeg",
      quality,
    );
  });

const compressPhoto = async (file) => {
  if (!(file instanceof File) || !file.type.startsWith("image/") || file.size > 15_000_000) {
    throw new Error("15MB以下のJPEG・PNG・WebPを選んでください");
  }
  const bitmap = await createImageBitmap(file);
  try {
    let side = 1280;
    let quality = 0.82;
    let result = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const ratio = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("写真を縮小できません");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      result = await blobFromCanvas(canvas, quality);
      if (result.size <= 680_000) break;
      side = Math.round(side * 0.82);
      quality = Math.max(0.58, quality - 0.06);
    }
    if (!result || result.size > 680_000) throw new Error("写真を700KB以下にできません");
    return result;
  } finally {
    bitmap.close();
  }
};

const postForm = document.querySelector("[data-post-form]");
postForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(postForm instanceof HTMLFormElement)) return;
  const button = postForm.querySelector('button[type="submit"]');
  if (button instanceof HTMLButtonElement) button.disabled = true;
  setComposerState("カードを整えています…", "working");
  const values = new FormData(postForm);
  const displayName = rememberName(String(values.get("displayName") ?? ""));
  const photoInput = document.querySelector("[data-photo-input]");
  try {
    const payload = new FormData();
    payload.set("body", String(values.get("body") ?? ""));
    payload.set("displayName", displayName);
    payload.set("kind", String(values.get("kind") ?? ""));
    payload.set("title", String(values.get("title") ?? ""));
    const file = photoInput instanceof HTMLInputElement ? photoInput.files?.[0] : null;
    if (file) {
      setComposerState("写真を端末内で縮小しています…", "working");
      payload.set("photo", await compressPhoto(file), "photo.jpg");
    }
    const response = await fetch(`/api/boards/${boardId}/posts`, {
      body: payload,
      headers: headers(),
      method: "POST",
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const name = displayName;
    postForm.reset();
    const nameInput = postForm.elements.namedItem("displayName");
    if (nameInput instanceof HTMLInputElement) nameInput.value = name;
    const defaultKind = postForm.querySelector('[name="kind"][value="notice"]');
    if (defaultKind instanceof HTMLInputElement) defaultKind.checked = true;
    const label = document.querySelector("[data-photo-label]");
    if (label) label.textContent = "＋ 写真を1枚添える";
    setComposerState("カードを貼りました", "ready");
    await loadBoard();
  } catch (error) {
    setComposerState(error instanceof Error ? error.message : "投稿できませんでした", "error");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
});

document.querySelector("[data-photo-input]")?.addEventListener("change", (event) => {
  const input = event.currentTarget;
  const label = document.querySelector("[data-photo-label]");
  if (input instanceof HTMLInputElement && label) {
    label.textContent = input.files?.[0]?.name ?? "＋ 写真を1枚添える";
  }
});

document.querySelector("[data-search]")?.addEventListener("input", (event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  searchTerm = input.value.normalize("NFKC").trim().toLocaleLowerCase("ja");
  renderPosts();
});

document.querySelectorAll("[data-kind]").forEach((button) => {
  button.addEventListener("click", () => {
    activeKind = button.getAttribute("data-kind") ?? "all";
    document.querySelectorAll("[data-kind]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    renderPosts();
  });
});

document.querySelector('[data-action="copy-share"]')?.addEventListener("click", async () => {
  const shareUrl = `${location.origin}/b/${boardId}#key=${accessKey}`;
  try {
    await navigator.clipboard.writeText(shareUrl);
    setStatus("共有用の合い鍵URLをコピーしました", "ready");
  } catch {
    prompt("この共有用URLをコピーしてください", shareUrl);
  }
});

document.querySelector('[data-action="copy-manage"]')?.addEventListener("click", async () => {
  const manageUrl = `${location.origin}/b/${boardId}#key=${accessKey}&manage=${manageKey}`;
  try {
    await navigator.clipboard.writeText(manageUrl);
    setStatus("管理用URLをコピーしました。共有相手には渡さないでください", "ready");
  } catch {
    prompt("この管理用URLを安全な場所に保存してください", manageUrl);
  }
});

document.querySelector('[data-action="export"]')?.addEventListener("click", async () => {
  try {
    const response = await fetch(`/api/boards/${boardId}/export`, { headers: headers() });
    if (!response.ok) throw new Error(await errorMessage(response));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `aikagi-ban-${boardId}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus("写真を除く板のJSONを保存しました", "ready");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "保存できませんでした", "error");
  }
});

document.querySelector('[data-action="delete-board"]')?.addEventListener("click", async () => {
  if (!confirm("板・投稿・返信・確認印・写真を削除します。元に戻せません。続けますか？")) return;
  const response = await fetch(`/api/boards/${boardId}`, {
    headers: headers(),
    method: "DELETE",
  });
  if (!response.ok) {
    setStatus(await errorMessage(response), "error");
    return;
  }
  sessionStorage.removeItem(`aikagi-key-${boardId}`);
  sessionStorage.removeItem(`aikagi-manage-${boardId}`);
  location.href = "/";
});

if (!accessKey) {
  const message = document.querySelector("[data-lock-message]");
  if (message)
    message.textContent = "合い鍵が見つかりません。共有されたURLをそのまま開いてください。";
} else {
  void loadBoard();
}

window.setInterval(() => {
  if (document.visibilityState === "visible" && accessKey) void loadBoard();
}, 20_000);

window.addEventListener("pagehide", () => {
  for (const url of photoUrls.values()) URL.revokeObjectURL(url);
});
