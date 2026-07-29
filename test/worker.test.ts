import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { app, scheduled, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_boards.sql", import.meta.url));
const appPath = fileURLToPath(new URL("../public/app.js", import.meta.url));
const boardPath = fileURLToPath(new URL("../public/board.js", import.meta.url));
const stylesPath = fileURLToPath(new URL("../public/styles.css", import.meta.url));
const origin = "http://localhost";
const session = "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a";
const secondSession = "489047e6-d840-4381-9574-563f3ecf3c20";

let miniflare: Miniflare;
let bindings: Bindings;

type CreatedBoard = {
  accessKey: string;
  expiresAt: number;
  id: string;
  manageKey: string;
};

const jsonRequest = (
  body: unknown,
  options: {
    accessKey?: string;
    manageKey?: string;
    origin?: string;
    qa?: boolean;
    session?: string;
  } = {},
) => ({
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    origin: options.origin ?? origin,
    "x-aikagi-key": options.accessKey ?? "",
    "x-aikagi-manage": options.manageKey ?? "",
    "x-aikagi-qa": options.qa ? "1" : "0",
    "x-aikagi-session": options.session ?? session,
  },
  method: "POST",
});

const authHeaders = (board: CreatedBoard, activeSession = session) => ({
  origin,
  "x-aikagi-key": board.accessKey,
  "x-aikagi-manage": board.manageKey,
  "x-aikagi-session": activeSession,
});

const createBoard = async (
  options: { qa?: boolean; session?: string; title?: string } = {},
): Promise<CreatedBoard> => {
  const response = await app.request(
    "/api/boards",
    jsonRequest(
      { description: "連絡と確認をひとつに", title: options.title ?? "夏祭り実行委員会" },
      { qa: options.qa, session: options.session },
    ),
    bindings,
  );
  expect(response.status).toBe(201);
  const payload = await response.json<{
    boardUrl: string;
    expiresAt: number;
    id: string;
    manageUrl: string;
  }>();
  const boardFragment = new URL(payload.boardUrl).hash.slice(1);
  const manageFragment = new URL(payload.manageUrl).hash.slice(1);
  const boardParameters = new URLSearchParams(boardFragment);
  const manageParameters = new URLSearchParams(manageFragment);
  return {
    accessKey: boardParameters.get("key") ?? "",
    expiresAt: payload.expiresAt,
    id: payload.id,
    manageKey: manageParameters.get("manage") ?? "",
  };
};

const createPost = async (
  board: CreatedBoard,
  options: { photo?: boolean; session?: string } = {},
) => {
  const form = new FormData();
  form.set("displayName", "佐藤");
  form.set("kind", "notice");
  form.set("title", "集合時刻");
  form.set("body", "土曜日の9時に集会所へ集合します。");
  if (options.photo) {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    form.set("photo", new File([jpeg], "map.jpg", { type: "image/jpeg" }));
  }
  const response = await app.request(
    `/api/boards/${board.id}/posts`,
    {
      body: form,
      headers: authHeaders(board, options.session),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return (await response.json<{ id: string }>()).id;
};

beforeEach(async () => {
  miniflare = new Miniflare({
    d1Databases: { DB: "aikagi-ban-test" },
    modules: true,
    r2Buckets: ["PHOTOS"],
    script: "export default { fetch() { return new Response('test') } }",
  });
  const database = await miniflare.getD1Database("DB");
  const photos = await miniflare.getR2Bucket("PHOTOS");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
  bindings = {
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Fetcher,
    DB: database as unknown as D1Database,
    PHOTOS: photos as unknown as R2Bucket,
  };
});

afterEach(async () => {
  await miniflare.dispose();
});

describe("public and private pages", () => {
  it.each([
    ["/", 'class="board-scene"', "https://aikagi-ban.yhay81.com/"],
    ["/guide", 'class="guide-steps"', "https://aikagi-ban.yhay81.com/guide"],
    ["/privacy", 'class="privacy-flow"', "https://aikagi-ban.yhay81.com/privacy"],
  ])("%s は製品固有の画面を返す", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/成功条件|市場スコア|公開実験/);
  });

  it("掲示板ページは検索対象外で、外部スクリプトと管理URL導線を持つ", async () => {
    const response = await app.request(`/b/${"a".repeat(32)}`, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(html).toContain('<meta content="noindex,nofollow" name="robots"');
    expect(html).toMatch(/<script defer(?:="")? src="\/board\.js"><\/script>/);
    expect(html).toContain('data-action="copy-manage"');
  });

  it("未知のページは404、静的アセットはASSETSへ渡す", async () => {
    const page = await app.request("/missing", undefined, bindings);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("この板は見つかりません");
    const asset = await app.request("/unknown.css", undefined, bindings);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("asset");
  });
});

describe("capability board workflow", () => {
  it("生の合い鍵をURL fragmentだけに返し、D1にはhashだけを保存する", async () => {
    const board = await createBoard();
    expect(board.id).toMatch(/^[0-9a-f]{32}$/);
    expect(board.accessKey).toMatch(/^[0-9a-f]{64}$/);
    expect(board.manageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(board.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86400);
    const row = await bindings.DB.prepare(
      "SELECT access_token_hash, organizer_token_hash FROM boards WHERE id = ?",
    )
      .bind(board.id)
      .first<{ access_token_hash: string; organizer_token_hash: string }>();
    expect(row?.access_token_hash).toHaveLength(64);
    expect(row?.organizer_token_hash).toHaveLength(64);
    expect(row?.access_token_hash).not.toBe(board.accessKey);
    expect(row?.organizer_token_hash).not.toBe(board.manageKey);
  });

  it("不正な鍵を拒否し、共有鍵と管理鍵の権限を分ける", async () => {
    const board = await createBoard();
    const denied = await app.request(
      `/api/boards/${board.id}`,
      { headers: { ...authHeaders(board), "x-aikagi-key": "0".repeat(64) } },
      bindings,
    );
    expect(denied.status).toBe(403);

    const opened = await app.request(
      `/api/boards/${board.id}`,
      { headers: { ...authHeaders(board), "x-aikagi-manage": "" } },
      bindings,
    );
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ isOrganizer: false, posts: [] });

    const organized = await app.request(
      `/api/boards/${board.id}`,
      { headers: authHeaders(board) },
      bindings,
    );
    expect(await organized.json()).toMatchObject({ isOrganizer: true });
  });

  it("写真投稿、返信、確認印、固定、JSON保存を一連で処理する", async () => {
    const board = await createBoard({ qa: true });
    const postId = await createPost(board, { photo: true });

    const photo = await app.request(
      `/api/boards/${board.id}/posts/${postId}/photo`,
      { headers: authHeaders(board) },
      bindings,
    );
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await photo.arrayBuffer())).toHaveLength(8);

    const comment = await app.request(
      `/api/boards/${board.id}/posts/${postId}/comments`,
      jsonRequest(
        { body: "確認しました。", displayName: "田中" },
        {
          accessKey: board.accessKey,
          manageKey: board.manageKey,
          qa: true,
          session: secondSession,
        },
      ),
      bindings,
    );
    expect(comment.status).toBe(201);

    const acknowledged = await app.request(
      `/api/boards/${board.id}/posts/${postId}/ack`,
      {
        ...jsonRequest(
          { displayName: "田中" },
          {
            accessKey: board.accessKey,
            manageKey: board.manageKey,
            qa: true,
            session: secondSession,
          },
        ),
        method: "PUT",
      },
      bindings,
    );
    expect(acknowledged.status).toBe(200);

    const pinned = await app.request(
      `/api/boards/${board.id}/posts/${postId}`,
      {
        ...jsonRequest(
          { pinned: true },
          { accessKey: board.accessKey, manageKey: board.manageKey, qa: true },
        ),
        method: "PATCH",
      },
      bindings,
    );
    expect(await pinned.json()).toEqual({ pinned: true });

    const opened = await app.request(
      `/api/boards/${board.id}`,
      { headers: authHeaders(board, secondSession) },
      bindings,
    );
    expect(await opened.json()).toMatchObject({
      board: { commentCount: 1, postCount: 1 },
      posts: [
        {
          acknowledged: true,
          comments: [{ body: "確認しました。", display_name: "田中" }],
          hasPhoto: true,
          isPinned: true,
        },
      ],
    });

    const exported = await app.request(
      `/api/boards/${board.id}/export`,
      { headers: { ...authHeaders(board), "x-aikagi-qa": "1" } },
      bindings,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(`aikagi-ban-${board.id}.json`);
    expect(await exported.json()).toMatchObject({
      photosIncluded: false,
      version: 1,
    });

    const qaEvents = await bindings.DB.prepare(
      "SELECT COUNT(*) AS count FROM product_events WHERE is_qa = 1",
    ).first<{ count: number }>();
    expect(qaEvents?.count).toBe(4);
  });

  it("管理者だけが投稿と板を削除し、写真も残さない", async () => {
    const board = await createBoard();
    const postId = await createPost(board, { photo: true });
    const denied = await app.request(
      `/api/boards/${board.id}/posts/${postId}`,
      {
        headers: { ...authHeaders(board), "x-aikagi-manage": "" },
        method: "DELETE",
      },
      bindings,
    );
    expect(denied.status).toBe(403);

    const removed = await app.request(
      `/api/boards/${board.id}/posts/${postId}`,
      { headers: authHeaders(board), method: "DELETE" },
      bindings,
    );
    expect(removed.status).toBe(204);
    expect(await bindings.PHOTOS.get(`${board.id}/${postId}.jpg`)).toBeNull();

    const secondPost = await createPost(board, { photo: true });
    const destroyed = await app.request(
      `/api/boards/${board.id}`,
      { headers: authHeaders(board), method: "DELETE" },
      bindings,
    );
    expect(destroyed.status).toBe(204);
    expect(await bindings.PHOTOS.get(`${board.id}/${secondPost}.jpg`)).toBeNull();
    expect(
      await bindings.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(board.id).first(),
    ).toBeNull();
  });
});

describe("input and telemetry boundaries", () => {
  it("別origin、不正JSON、連絡先入り表示名を拒否する", async () => {
    const crossSite = await app.request(
      "/api/boards",
      jsonRequest({ description: "", title: "板" }, { origin: "https://example.com" }),
      bindings,
    );
    expect(crossSite.status).toBe(403);

    const malformed = await app.request(
      "/api/events",
      {
        body: "{",
        headers: { "content-type": "application/json", "x-aikagi-session": session },
        method: "POST",
      },
      bindings,
    );
    expect(malformed.status).toBe(400);

    const board = await createBoard();
    const form = new FormData();
    form.set("displayName", "mail@example.com");
    form.set("kind", "notice");
    form.set("title", "連絡");
    form.set("body", "本文");
    const contact = await app.request(
      `/api/boards/${board.id}/posts`,
      { body: form, headers: authHeaders(board), method: "POST" },
      bindings,
    );
    expect(contact.status).toBe(400);
    expect(await contact.json()).toMatchObject({
      error: "contact_not_allowed_in_display_name",
    });
  });

  it("クライアントイベントを許可リストに限定し、QAを実利用から分離する", async () => {
    for (const name of ["visited", "board_opened", "returned"]) {
      const accepted = await app.request(
        "/api/events",
        jsonRequest({ boardId: null, name }),
        bindings,
      );
      expect(accepted.status).toBe(202);
    }
    const rejected = await app.request(
      "/api/events",
      jsonRequest({ boardId: null, name: "post_created" }),
      bindings,
    );
    expect(rejected.status).toBe(400);

    await app.request(
      "/api/events",
      jsonRequest({ boardId: null, name: "visited" }, { qa: true }),
      bindings,
    );
    const rows = await bindings.DB.prepare(
      "SELECT is_qa, COUNT(*) AS count FROM product_events GROUP BY is_qa ORDER BY is_qa",
    ).all<{ count: number; is_qa: number }>();
    expect(rows.results).toEqual([
      { count: 3, is_qa: 0 },
      { count: 1, is_qa: 1 },
    ]);
  });

  it("期限切れの板・写真と45日を過ぎたイベントを定期削除する", async () => {
    const board = await createBoard();
    const postId = await createPost(board, { photo: true });
    const now = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare("UPDATE boards SET expires_at = ? WHERE id = ?")
      .bind(now - 1, board.id)
      .run();
    await bindings.DB.prepare(
      `INSERT INTO product_events (name, session_id, day, created_at, is_qa)
       VALUES ('visited', ?, '2026-01-01', ?, 0)`,
    )
      .bind(session, now - 46 * 86400)
      .run();

    await scheduled({} as ScheduledController, bindings, {} as ExecutionContext);
    expect(
      await bindings.DB.prepare("SELECT id FROM boards WHERE id = ?").bind(board.id).first(),
    ).toBeNull();
    expect(await bindings.PHOTOS.get(`${board.id}/${postId}.jpg`)).toBeNull();
    const oldEvent = await bindings.DB.prepare(
      "SELECT id FROM product_events WHERE created_at <= ?",
    )
      .bind(now - 45 * 86400)
      .first();
    expect(oldEvent).toBeNull();
  });
});

describe("client safety contract", () => {
  it("写真を端末でJPEGへ縮小し、利用者入力をHTMLとして解釈しない", async () => {
    const [appSource, boardSource, styles] = await Promise.all([
      readFile(appPath, "utf8"),
      readFile(boardPath, "utf8"),
      readFile(stylesPath, "utf8"),
    ]);
    expect(appSource).toContain('fetch("/api/boards"');
    expect(boardSource).toContain("createImageBitmap");
    expect(boardSource).toContain("canvas.toBlob");
    expect(boardSource).toContain("680_000");
    expect(boardSource).toContain("#key=");
    expect(boardSource).toContain("&manage=");
    expect(boardSource).not.toMatch(/innerHTML|eval\(|new Function/);
    expect(styles).toContain(".board-scene");
    expect(styles).toContain(".message-board");
  });
});
