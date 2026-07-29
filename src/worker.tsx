import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

export type Bindings = {
  ASSETS: Fetcher;
  DB: D1Database;
  PHOTOS: R2Bucket;
};

type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type ApiStatus = 400 | 403 | 404 | 409 | 410 | 413 | 415 | 429;

type BoardRow = {
  comment_count: number;
  created_at: number;
  description: string;
  expires_at: number;
  id: string;
  organizer_token_hash: string;
  post_count: number;
  title: string;
  access_token_hash: string;
};

type PostRow = {
  body: string;
  created_at: number;
  display_name: string;
  id: string;
  is_pinned: number;
  kind: "notice" | "question" | "note";
  photo_key: string | null;
  title: string;
};

type CommentRow = {
  body: string;
  created_at: number;
  display_name: string;
  id: string;
  post_id: string;
};

type AcknowledgementRow = {
  created_at: number;
  display_name: string;
  is_current: number;
  post_id: string;
};

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: ApiStatus,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const canonicalOrigin = "https://aikagi-ban.yhay81.com";
const boardPattern = /^[0-9a-f]{32}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientEventNames = new Set(["visited", "board_opened", "returned"]);
const allEventNames = new Set([
  ...clientEventNames,
  "board_created",
  "post_created",
  "comment_created",
  "acknowledged",
  "photo_added",
  "board_exported",
]);
const boardLifetime = 30 * 86400;
const eventLifetime = 45 * 86400;
const maximumPhotoBytes = 700_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jstDay = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const randomHex = (bytes: number) => {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const cleanText = (value: unknown, maximum: number, minimum = 0) => {
  if (typeof value !== "string") throw new ApiError("invalid_text", 400);
  const cleaned = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    // oxlint-disable-next-line no-control-regex -- remove non-printing input before storage
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  if (cleaned.length < minimum || cleaned.length > maximum) {
    throw new ApiError("invalid_text", 400);
  }
  return cleaned;
};

const cleanDisplayName = (value: unknown) => {
  const displayName = cleanText(value, 24, 1);
  if (/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\d[\s().-]*){8,})/iu.test(displayName)) {
    throw new ApiError("contact_not_allowed_in_display_name", 400);
  }
  return displayName;
};

const requireSession = (c: AppContext) => {
  const sessionId = c.req.header("x-aikagi-session") ?? "";
  if (!sessionPattern.test(sessionId)) throw new ApiError("invalid_session", 400);
  return sessionId.toLowerCase();
};

const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    throw new ApiError("cross_site_request", 403);
  }
};

const parseJson = async (c: AppContext, maximumBytes = 4096) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > maximumBytes) throw new ApiError("payload_too_large", 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};

const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};

const boardIdFrom = (value: string) => {
  if (!boardPattern.test(value)) throw new ApiError("not_found", 404);
  return value;
};

const getBoard = async (c: AppContext, id: string) => {
  const board = await c.env.DB.prepare("SELECT * FROM boards WHERE id = ?")
    .bind(id)
    .first<BoardRow>();
  if (!board) throw new ApiError("not_found", 404);
  if (board.expires_at <= nowSeconds()) throw new ApiError("board_expired", 410);
  return board;
};

const authenticateBoard = async (c: AppContext, id: string) => {
  enforceSameOrigin(c);
  const board = await getBoard(c, id);
  const token = c.req.header("x-aikagi-key") ?? "";
  if (!tokenPattern.test(token)) throw new ApiError("invalid_key", 403);
  const candidateHash = await sha256(token.toLowerCase());
  if (!constantTimeEqual(candidateHash, board.access_token_hash)) {
    throw new ApiError("invalid_key", 403);
  }
  return board;
};

const authenticateOrganizer = async (c: AppContext, id: string) => {
  const board = await authenticateBoard(c, id);
  const token = c.req.header("x-aikagi-manage") ?? "";
  if (!tokenPattern.test(token)) throw new ApiError("organizer_required", 403);
  const candidateHash = await sha256(token.toLowerCase());
  if (!constantTimeEqual(candidateHash, board.organizer_token_hash)) {
    throw new ApiError("organizer_required", 403);
  }
  return board;
};

const isOrganizer = async (c: AppContext, board: BoardRow) => {
  const token = c.req.header("x-aikagi-manage") ?? "";
  if (!tokenPattern.test(token)) return false;
  return constantTimeEqual(await sha256(token.toLowerCase()), board.organizer_token_hash);
};

const incrementLimit = async (
  database: D1Database,
  boardId: string,
  sessionId: string,
  kind: "post" | "comment",
  maximum: number,
) => {
  const row = await database
    .prepare(
      `INSERT INTO write_limits (board_id, session_id, day, kind, count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(board_id, session_id, day, kind)
       DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(boardId, sessionId, jstDay(), kind, maximum)
    .first<{ count: number }>();
  if (!row) throw new ApiError("rate_limited", 429);
};

const recordEvent = async (
  env: Bindings,
  name: string,
  sessionId: string,
  boardId: string | null,
  qa: boolean,
) => {
  if (!allEventNames.has(name)) throw new Error("unallowlisted_event");
  await env.DB.prepare(
    `INSERT INTO product_events (name, session_id, board_id, day, created_at, is_qa)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, sessionId, boardId, jstDay(), nowSeconds(), qa ? 1 : 0)
    .run();
};

const qaRequest = (c: AppContext) => c.req.header("x-aikagi-qa") === "1";

const parsePostForm = async (c: AppContext) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > 800_000) throw new ApiError("payload_too_large", 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > 800_000) throw new ApiError("payload_too_large", 413);
  try {
    return await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ApiError("invalid_form", 400);
  }
};

const validJpeg = async (file: File) => {
  if (file.type !== "image/jpeg" || file.size === 0 || file.size > maximumPhotoBytes) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
};

const deletePhotoPrefix = async (bucket: R2Bucket, boardId: string) => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, prefix: `${boardId}/` });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  script,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  script?: string;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      <link href={canonical} rel="canonical" />
      <meta content={noindex ? "noindex,nofollow" : "index,follow"} name="robots" />
      <meta content="website" property="og:type" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content={`${canonicalOrigin}/og.svg`} property="og:image" />
      <meta content="#315d56" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      {script ? <script defer src={script}></script> : null}
    </head>
    <body>
      <header class="site-header">
        <a class="brand" href="/" aria-label="合鍵板 ホーム">
          <span class="key-mark" aria-hidden="true">
            <i></i>
            <b></b>
          </span>
          <span>合鍵板</span>
        </a>
        <nav aria-label="補助ページ">
          <a href="/guide">使い方</a>
          <a href="/privacy">保存と削除</a>
        </nav>
      </header>
      {children}
      <footer>
        <span>合鍵板</span>
        <span>合い鍵を知る人だけ・30日で片づく</span>
        <a href="https://github.com/yhay81/aikagi-ban">GitHub</a>
      </footer>
    </body>
  </html>
);

const LandingPage = () => (
  <Layout
    canonical={`${canonicalOrigin}/`}
    description="URLの合い鍵を渡した人だけで、投稿・返信・確認印・写真を30日共有する小さな掲示板です。"
    script="/app.js"
    title="合鍵板｜合い鍵を渡す、小さな連絡板"
  >
    <main class="landing" data-page="landing">
      <section class="board-scene" aria-label="合鍵板の利用イメージ">
        <div class="scene-label">
          <span>PRIVATE BOARD</span>
          <strong>合い鍵を渡す、小さな連絡板。</strong>
        </div>
        <article class="sample-card notice">
          <span class="pushpin orange"></span>
          <small>お知らせ</small>
          <h2>集合は東口 9:30</h2>
          <p>青い旗の前に集まってください。</p>
          <div class="stamp-row">
            <span>確認 5</span>
            <i>✓</i>
          </div>
        </article>
        <article class="sample-card question">
          <span class="pushpin green"></span>
          <small>質問</small>
          <h2>雨具は必要ですか？</h2>
          <p>折りたたみ傘で大丈夫です。</p>
          <div class="reply-tabs">
            <i></i>
            <i></i>
            <b>2</b>
          </div>
        </article>
        <article class="sample-card photo">
          <span class="pushpin blue"></span>
          <div class="sample-photo" aria-hidden="true">
            <i></i>
            <b></b>
          </div>
          <h2>会場の入口</h2>
          <p>この看板が目印です。</p>
        </article>
        <div class="hanging-key" aria-hidden="true">
          <span></span>
          <i></i>
          <b></b>
        </div>
        <div class="expiry-strip">
          <i></i>
          <span>30日後に板も写真も片づきます</span>
        </div>
      </section>

      <section class="create-panel">
        <div class="panel-heading">
          <div class="mini-door" aria-hidden="true">
            <i></i>
            <b></b>
          </div>
          <div>
            <p class="eyebrow">HANG A BOARD</p>
            <h1>新しい板をかける</h1>
          </div>
        </div>
        <form data-create-form>
          <label>
            板名
            <input name="title" maxlength={64} placeholder="例：秋の遠足 連絡板" required />
          </label>
          <label>
            この板の用途
            <textarea
              name="description"
              maxlength={240}
              placeholder="例：集合、持ち物、当日の変更をここへまとめます"
            ></textarea>
          </label>
          <div class="creation-facts">
            <span>
              <i>⌁</i>参加者登録なし
            </span>
            <span>
              <i>30</i>日で自動削除
            </span>
            <span>
              <i>⌕</i>公開一覧なし
            </span>
          </div>
          <button class="create-button" type="submit">
            <span class="button-key" aria-hidden="true"></span>
            合い鍵つきの板を作る
          </button>
          <p class="form-note" data-create-state>
            作成後に共有用URLと管理用URLを分けて保存してください。
          </p>
        </form>
      </section>
    </main>
  </Layout>
);

const BoardPage = ({ id }: { id: string }) => (
  <Layout
    canonical={`${canonicalOrigin}/`}
    description="合い鍵を知る人だけが利用できる30日間の掲示板です。"
    noindex
    script="/board.js"
    title="連絡板｜合鍵板"
  >
    <main class="private-board-shell" data-board-id={id} data-page="board">
      <section class="locked-board" data-locked-board>
        <div class="lock-plate" aria-hidden="true">
          <span></span>
          <i></i>
        </div>
        <p class="eyebrow">PRIVATE BOARD</p>
        <h1>合い鍵を確認しています</h1>
        <p data-lock-message>共有されたURLをそのまま開いてください。</p>
      </section>

      <div class="board-app" data-board-app hidden>
        <header class="board-header">
          <div>
            <p class="eyebrow">30-DAY BOARD</p>
            <h1 data-board-title></h1>
            <p data-board-description></p>
          </div>
          <div class="board-tools">
            <span class="expiry-badge" data-expiry-badge></span>
            <button data-action="copy-share" type="button">
              合い鍵をコピー
            </button>
            <button data-action="copy-manage" data-organizer-only hidden type="button">
              管理URLをコピー
            </button>
            <button data-action="export" data-organizer-only hidden type="button">
              JSON保存
            </button>
            <button
              class="danger"
              data-action="delete-board"
              data-organizer-only
              hidden
              type="button"
            >
              板を片づける
            </button>
          </div>
        </header>

        <div class="board-layout">
          <aside class="board-sidebar">
            <div class="board-counts">
              <div>
                <strong data-post-count>0</strong>
                <small>投稿</small>
              </div>
              <div>
                <strong data-comment-count>0</strong>
                <small>返信</small>
              </div>
              <div>
                <strong data-member-count>0</strong>
                <small>確認した人</small>
              </div>
            </div>
            <label class="search-box">
              <span aria-hidden="true">⌕</span>
              <input data-search maxlength={80} placeholder="板の中を検索" />
            </label>
            <div class="kind-filter" role="group" aria-label="投稿種別">
              <button class="active" data-kind="all" type="button">
                すべて
              </button>
              <button data-kind="notice" type="button">
                お知らせ
              </button>
              <button data-kind="question" type="button">
                質問
              </button>
              <button data-kind="note" type="button">
                メモ
              </button>
            </div>
            <div class="key-pocket">
              <span class="pocket-key" aria-hidden="true"></span>
              <div>
                <strong>このURLが合い鍵です</strong>
                <p>必要な人へだけ渡してください。管理URLは共有しません。</p>
              </div>
            </div>
          </aside>

          <section class="message-board" aria-label="投稿一覧">
            <div class="board-status" data-board-status>
              <i></i>
              <span>板を読み込んでいます</span>
            </div>
            <div class="post-grid" data-post-grid></div>
            <div class="empty-board" data-empty-board hidden>
              <span class="empty-pin"></span>
              <h2>まだ何も貼られていません</h2>
              <p>最初のお知らせや質問を貼ってみましょう。</p>
            </div>
          </section>

          <aside class="composer">
            <div class="composer-heading">
              <span class="paper-stack" aria-hidden="true"></span>
              <div>
                <p class="eyebrow">NEW CARD</p>
                <h2>板へ貼る</h2>
              </div>
            </div>
            <form data-post-form>
              <label>
                表示名
                <input name="displayName" maxlength={24} placeholder="例：佐藤" required />
              </label>
              <div class="kind-picks">
                <label>
                  <input checked name="kind" type="radio" value="notice" />
                  <span>お知らせ</span>
                </label>
                <label>
                  <input name="kind" type="radio" value="question" />
                  <span>質問</span>
                </label>
                <label>
                  <input name="kind" type="radio" value="note" />
                  <span>メモ</span>
                </label>
              </div>
              <label>
                見出し
                <input name="title" maxlength={80} placeholder="ひと目でわかる見出し" required />
              </label>
              <label>
                本文
                <textarea
                  name="body"
                  maxlength={1000}
                  placeholder="必要なことを短くまとめます"
                  required
                ></textarea>
              </label>
              <label class="photo-picker">
                <input accept="image/jpeg,image/png,image/webp" data-photo-input type="file" />
                <span data-photo-label>＋ 写真を1枚添える</span>
                <small>端末内でJPEG・700KB以下へ縮小</small>
              </label>
              <button type="submit">カードを貼る</button>
              <p class="composer-state" data-composer-state></p>
            </form>
          </aside>
        </div>
      </div>

      <template id="post-template">
        <article class="board-post">
          <span class="pushpin"></span>
          <div class="post-top">
            <span data-post-kind></span>
            <time data-post-time></time>
          </div>
          <h2 data-post-title></h2>
          <p class="post-body" data-post-body></p>
          <div class="post-photo" data-post-photo-wrap hidden>
            <div class="photo-loading">写真を開いています</div>
            <img alt="" data-post-photo />
          </div>
          <div class="ack-row">
            <button data-post-action="ack" type="button">
              <span>✓</span>
              <b>確認</b>
              <i data-ack-count>0</i>
            </button>
            <div class="ack-names" data-ack-names></div>
          </div>
          <div class="comments" data-comments></div>
          <form class="comment-form" data-comment-form>
            <input name="displayName" maxlength={24} placeholder="表示名" required />
            <input name="body" maxlength={300} placeholder="返信を書く" required />
            <button type="submit">返信</button>
          </form>
          <div class="organizer-actions" data-organizer-actions hidden>
            <button data-post-action="pin" type="button">
              固定
            </button>
            <button class="danger" data-post-action="delete" type="button">
              削除
            </button>
          </div>
        </article>
      </template>

      <template id="comment-template">
        <div class="comment">
          <span data-comment-name></span>
          <p data-comment-body></p>
          <time data-comment-time></time>
        </div>
      </template>
    </main>
  </Layout>
);

const GuidePage = () => (
  <Layout
    canonical={`${canonicalOrigin}/guide`}
    description="合鍵板を作り、共有し、確認印を集め、30日後に片づける流れです。"
    title="使い方｜合鍵板"
  >
    <main class="info-page">
      <div class="info-heading">
        <div class="guide-key" aria-hidden="true">
          <i></i>
          <b></b>
        </div>
        <div>
          <p class="eyebrow">FOUR TURNS</p>
          <h1>板をかけて、合い鍵を渡す。</h1>
        </div>
      </div>
      <ol class="guide-steps">
        <li>
          <span class="step-visual door">
            <i></i>
            <b></b>
          </span>
          <div>
            <b>01</b>
            <h2>板を作る</h2>
            <p>板名と用途を入れると、共有用と管理用の2本のURLができます。</p>
          </div>
        </li>
        <li>
          <span class="step-visual keys">
            <i></i>
            <b></b>
          </span>
          <div>
            <b>02</b>
            <h2>合い鍵を渡す</h2>
            <p>共有用URLだけを参加者へ。管理用URLは作成者の手元に残します。</p>
          </div>
        </li>
        <li>
          <span class="step-visual cards">
            <i></i>
            <b></b>
          </span>
          <div>
            <b>03</b>
            <h2>貼って、返して、確認する</h2>
            <p>お知らせ・質問・メモへ返信と確認印を集めます。</p>
          </div>
        </li>
        <li>
          <span class="step-visual box">
            <i></i>
            <b></b>
          </span>
          <div>
            <b>04</b>
            <h2>必要なら保存して片づける</h2>
            <p>管理者はJSONを保存できます。板は終了時または30日後に消えます。</p>
          </div>
        </li>
      </ol>
      <section class="safety-card">
        <span>!</span>
        <div>
          <h2>秘密の保管庫ではありません</h2>
          <p>
            住所、電話、健康情報、認証コード、決済情報、長期保管が必要な記録は載せないでください。
          </p>
        </div>
      </section>
    </main>
  </Layout>
);

const PrivacyPage = () => (
  <Layout
    canonical={`${canonicalOrigin}/privacy`}
    description="合鍵板で共有する内容、鍵の保存、30日後の自動削除について説明します。"
    title="保存と削除｜合鍵板"
  >
    <main class="info-page">
      <div class="info-heading">
        <div class="expiry-box" aria-hidden="true">
          <span>30</span>
          <i></i>
        </div>
        <div>
          <p class="eyebrow">PACKED IN 30 DAYS</p>
          <h1>板も写真も、置きっぱなしにしない。</h1>
        </div>
      </div>
      <div class="privacy-flow">
        <div>
          <span class="flow-board">▤</span>
          <b>板・投稿・返信</b>
          <small>D1へ暗号化通信</small>
        </div>
        <div>
          <span class="flow-photo">▧</span>
          <b>再圧縮した写真</b>
          <small>非公開R2へ</small>
        </div>
        <span class="flow-arrow">→</span>
        <div class="flow-expire">
          <span>30</span>
          <b>終了または期限</b>
          <small>内容を削除</small>
        </div>
      </div>
      <section class="privacy-copy">
        <h2>合い鍵</h2>
        <p>
          共有鍵と管理鍵の生値はURLの#以降にだけ置き、サーバーにはSHA-256
          hashを保存します。アクセス先のサーバーログや検索エンジンへ鍵を含めません。
        </p>
        <h2>写真</h2>
        <p>
          ブラウザでJPEGへ描き直すため、位置情報などの元画像メタデータを送りません。R2は公開せず、合い鍵を確認したWorkerだけが写真を返します。
        </p>
        <h2>匿名の利用計測</h2>
        <p>
          操作名、ランダムなブラウザID、任意の板ID、日付だけを45日間保存します。検索語、板名、投稿本文、表示名、写真は計測へ含めません。
        </p>
      </section>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", (c) => c.html(<LandingPage />));
app.get("/guide", (c) => c.html(<GuidePage />));
app.get("/privacy", (c) => c.html(<PrivacyPage />));
app.get("/b/:id", (c) => {
  const id = boardIdFrom(c.req.param("id"));
  c.header("Cache-Control", "private, no-store");
  return c.html(<BoardPage id={id} />);
});

app.post("/api/boards", async (c) => {
  enforceSameOrigin(c);
  const sessionId = requireSession(c);
  const payload = objectPayload(await parseJson(c));
  const title = cleanText(payload.title, 64, 1);
  const description = cleanText(payload.description ?? "", 240);
  const limit = await c.env.DB.prepare(
    `INSERT INTO creation_limits (session_id, day, count)
     VALUES (?, ?, 1)
     ON CONFLICT(session_id, day)
     DO UPDATE SET count = count + 1 WHERE count < 3
     RETURNING count`,
  )
    .bind(sessionId, jstDay())
    .first<{ count: number }>();
  if (!limit) throw new ApiError("create_rate_limited", 429);

  const id = randomHex(16);
  const accessToken = randomHex(32);
  const organizerToken = randomHex(32);
  const createdAt = nowSeconds();
  await c.env.DB.prepare(
    `INSERT INTO boards
       (id, title, description, access_token_hash, organizer_token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      title,
      description,
      await sha256(accessToken),
      await sha256(organizerToken),
      createdAt,
      createdAt + boardLifetime,
    )
    .run();
  await recordEvent(c.env, "board_created", sessionId, id, qaRequest(c));

  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      boardUrl: `${origin}/b/${id}#key=${accessToken}`,
      expiresAt: createdAt + boardLifetime,
      id,
      manageUrl: `${origin}/b/${id}#key=${accessToken}&manage=${organizerToken}`,
    },
    201,
  );
});

app.get("/api/boards/:id", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const sessionId = requireSession(c);
  const board = await authenticateBoard(c, id);
  const [postsResult, commentsResult, acknowledgementsResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, display_name, kind, title, body, photo_key, is_pinned, created_at
       FROM posts
       WHERE board_id = ? AND deleted_at IS NULL
       ORDER BY is_pinned DESC, created_at DESC`,
    )
      .bind(id)
      .all<PostRow>(),
    c.env.DB.prepare(
      `SELECT id, post_id, display_name, body, created_at
       FROM comments
       WHERE board_id = ? AND deleted_at IS NULL
       ORDER BY created_at`,
    )
      .bind(id)
      .all<CommentRow>(),
    c.env.DB.prepare(
      `SELECT post_id, display_name, created_at,
              CASE WHEN session_id = ? THEN 1 ELSE 0 END AS is_current
       FROM acknowledgements
       WHERE board_id = ?
       ORDER BY created_at`,
    )
      .bind(sessionId, id)
      .all<AcknowledgementRow>(),
  ]);
  const commentsByPost = new Map<string, CommentRow[]>();
  for (const comment of commentsResult.results) {
    const comments = commentsByPost.get(comment.post_id) ?? [];
    comments.push(comment);
    commentsByPost.set(comment.post_id, comments);
  }
  const acknowledgementsByPost = new Map<string, AcknowledgementRow[]>();
  for (const acknowledgement of acknowledgementsResult.results) {
    const acknowledgements = acknowledgementsByPost.get(acknowledgement.post_id) ?? [];
    acknowledgements.push(acknowledgement);
    acknowledgementsByPost.set(acknowledgement.post_id, acknowledgements);
  }

  c.header("Cache-Control", "private, no-store");
  return c.json({
    board: {
      commentCount: board.comment_count,
      createdAt: board.created_at,
      description: board.description,
      expiresAt: board.expires_at,
      id: board.id,
      postCount: board.post_count,
      title: board.title,
    },
    isOrganizer: await isOrganizer(c, board),
    posts: postsResult.results.map((post) => {
      const acknowledgements = acknowledgementsByPost.get(post.id) ?? [];
      return {
        acknowledgements: acknowledgements.map((item) => ({
          createdAt: item.created_at,
          displayName: item.display_name,
        })),
        acknowledged: acknowledgements.some((item) => item.is_current === 1),
        body: post.body,
        comments: commentsByPost.get(post.id) ?? [],
        createdAt: post.created_at,
        displayName: post.display_name,
        hasPhoto: Boolean(post.photo_key),
        id: post.id,
        isPinned: post.is_pinned === 1,
        kind: post.kind,
        title: post.title,
      };
    }),
  });
});

app.post("/api/boards/:id/posts", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const sessionId = requireSession(c);
  const board = await authenticateBoard(c, id);
  if (board.post_count >= 200) throw new ApiError("board_full", 409);
  const form = await parsePostForm(c);
  const displayName = cleanDisplayName(form.get("displayName"));
  const kindValue = form.get("kind");
  if (kindValue !== "notice" && kindValue !== "question" && kindValue !== "note") {
    throw new ApiError("invalid_kind", 400);
  }
  const title = cleanText(form.get("title"), 80, 1);
  const body = cleanText(form.get("body"), 1000, 1);
  const photo = form.get("photo");
  if (photo !== null && (!(photo instanceof File) || !(await validJpeg(photo)))) {
    throw new ApiError("invalid_photo", 400);
  }
  await incrementLimit(c.env.DB, id, sessionId, "post", 10);

  const postId = randomHex(16);
  const photoKey = photo instanceof File ? `${id}/${postId}.jpg` : null;
  const createdAt = nowSeconds();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO posts
       (id, board_id, display_name, kind, title, body, photo_key, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT post_count FROM boards WHERE id = ?) < 200
     RETURNING id`,
  )
    .bind(postId, id, displayName, kindValue, title, body, photoKey, createdAt, id)
    .first<{ id: string }>();
  if (!inserted) throw new ApiError("board_full", 409);

  try {
    if (photo instanceof File && photoKey) {
      await c.env.PHOTOS.put(photoKey, await photo.arrayBuffer(), {
        customMetadata: { expiresAt: String(board.expires_at) },
        httpMetadata: { contentType: "image/jpeg" },
      });
    }
    await c.env.DB.prepare("UPDATE boards SET post_count = post_count + 1 WHERE id = ?")
      .bind(id)
      .run();
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(postId).run();
    if (photoKey) await c.env.PHOTOS.delete(photoKey);
    throw error;
  }
  await recordEvent(c.env, "post_created", sessionId, id, qaRequest(c));
  if (photoKey) await recordEvent(c.env, "photo_added", sessionId, id, qaRequest(c));
  return c.json({ id: postId }, 201);
});

app.post("/api/boards/:id/posts/:postId/comments", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const postId = boardIdFrom(c.req.param("postId"));
  const sessionId = requireSession(c);
  const board = await authenticateBoard(c, id);
  if (board.comment_count >= 500) throw new ApiError("board_full", 409);
  const payload = objectPayload(await parseJson(c));
  const displayName = cleanDisplayName(payload.displayName);
  const body = cleanText(payload.body, 300, 1);
  const post = await c.env.DB.prepare(
    "SELECT id FROM posts WHERE id = ? AND board_id = ? AND deleted_at IS NULL",
  )
    .bind(postId, id)
    .first<{ id: string }>();
  if (!post) throw new ApiError("not_found", 404);
  await incrementLimit(c.env.DB, id, sessionId, "comment", 30);
  const commentId = randomHex(16);
  const inserted = await c.env.DB.prepare(
    `INSERT INTO comments (id, board_id, post_id, display_name, body, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (SELECT comment_count FROM boards WHERE id = ?) < 500
     RETURNING id`,
  )
    .bind(commentId, id, postId, displayName, body, nowSeconds(), id)
    .first<{ id: string }>();
  if (!inserted) throw new ApiError("board_full", 409);
  await c.env.DB.prepare("UPDATE boards SET comment_count = comment_count + 1 WHERE id = ?")
    .bind(id)
    .run();
  await recordEvent(c.env, "comment_created", sessionId, id, qaRequest(c));
  return c.json({ id: commentId }, 201);
});

app.put("/api/boards/:id/posts/:postId/ack", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const postId = boardIdFrom(c.req.param("postId"));
  const sessionId = requireSession(c);
  await authenticateBoard(c, id);
  const payload = objectPayload(await parseJson(c));
  const displayName = cleanDisplayName(payload.displayName);
  const post = await c.env.DB.prepare(
    "SELECT id FROM posts WHERE id = ? AND board_id = ? AND deleted_at IS NULL",
  )
    .bind(postId, id)
    .first<{ id: string }>();
  if (!post) throw new ApiError("not_found", 404);
  const existing = await c.env.DB.prepare(
    "SELECT 1 AS found FROM acknowledgements WHERE post_id = ? AND session_id = ?",
  )
    .bind(postId, sessionId)
    .first<{ found: number }>();
  await c.env.DB.prepare(
    `INSERT INTO acknowledgements (post_id, board_id, session_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(post_id, session_id)
     DO UPDATE SET display_name = excluded.display_name, created_at = excluded.created_at`,
  )
    .bind(postId, id, sessionId, displayName, nowSeconds())
    .run();
  if (!existing) await recordEvent(c.env, "acknowledged", sessionId, id, qaRequest(c));
  return c.json({ acknowledged: true });
});

app.delete("/api/boards/:id/posts/:postId/ack", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const postId = boardIdFrom(c.req.param("postId"));
  const sessionId = requireSession(c);
  await authenticateBoard(c, id);
  await c.env.DB.prepare(
    "DELETE FROM acknowledgements WHERE post_id = ? AND board_id = ? AND session_id = ?",
  )
    .bind(postId, id, sessionId)
    .run();
  return c.body(null, 204);
});

app.patch("/api/boards/:id/posts/:postId", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const postId = boardIdFrom(c.req.param("postId"));
  requireSession(c);
  await authenticateOrganizer(c, id);
  const payload = objectPayload(await parseJson(c));
  if (typeof payload.pinned !== "boolean") throw new ApiError("invalid_request", 400);
  const result = await c.env.DB.prepare(
    `UPDATE posts SET is_pinned = ?
     WHERE id = ? AND board_id = ? AND deleted_at IS NULL`,
  )
    .bind(payload.pinned ? 1 : 0, postId, id)
    .run();
  if (result.meta.changes === 0) throw new ApiError("not_found", 404);
  return c.json({ pinned: payload.pinned });
});

app.delete("/api/boards/:id/posts/:postId", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const postId = boardIdFrom(c.req.param("postId"));
  requireSession(c);
  await authenticateOrganizer(c, id);
  const post = await c.env.DB.prepare(
    `SELECT photo_key,
            (SELECT COUNT(*) FROM comments WHERE post_id = posts.id) AS comment_count
     FROM posts WHERE id = ? AND board_id = ?`,
  )
    .bind(postId, id)
    .first<{ comment_count: number; photo_key: string | null }>();
  if (!post) throw new ApiError("not_found", 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM posts WHERE id = ? AND board_id = ?").bind(postId, id),
    c.env.DB.prepare(
      `UPDATE boards
       SET post_count = MAX(0, post_count - 1),
           comment_count = MAX(0, comment_count - ?)
       WHERE id = ?`,
    ).bind(post.comment_count, id),
  ]);
  if (post.photo_key) await c.env.PHOTOS.delete(post.photo_key);
  return c.body(null, 204);
});

app.get("/api/boards/:id/posts/:postId/photo", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const postId = boardIdFrom(c.req.param("postId"));
  requireSession(c);
  await authenticateBoard(c, id);
  const post = await c.env.DB.prepare(
    "SELECT photo_key FROM posts WHERE id = ? AND board_id = ? AND deleted_at IS NULL",
  )
    .bind(postId, id)
    .first<{ photo_key: string | null }>();
  if (!post?.photo_key) throw new ApiError("not_found", 404);
  const object = await c.env.PHOTOS.get(post.photo_key);
  if (!object) throw new ApiError("not_found", 404);
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Disposition", "inline");
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(await object.arrayBuffer(), { headers });
});

app.get("/api/boards/:id/export", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  const sessionId = requireSession(c);
  const board = await authenticateOrganizer(c, id);
  const [posts, comments, acknowledgements] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, display_name, kind, title, body, is_pinned, created_at
       FROM posts WHERE board_id = ? AND deleted_at IS NULL
       ORDER BY is_pinned DESC, created_at DESC`,
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      `SELECT id, post_id, display_name, body, created_at
       FROM comments WHERE board_id = ? AND deleted_at IS NULL ORDER BY created_at`,
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      `SELECT post_id, display_name, created_at
       FROM acknowledgements WHERE board_id = ? ORDER BY created_at`,
    )
      .bind(id)
      .all(),
  ]);
  await recordEvent(c.env, "board_exported", sessionId, id, qaRequest(c));
  const response = c.json({
    acknowledgements: acknowledgements.results,
    board: {
      createdAt: board.created_at,
      description: board.description,
      expiresAt: board.expires_at,
      id: board.id,
      title: board.title,
    },
    comments: comments.results,
    exportedAt: new Date().toISOString(),
    photosIncluded: false,
    posts: posts.results,
    version: 1,
  });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Content-Disposition", `attachment; filename="aikagi-ban-${id}.json"`);
  return response;
});

app.delete("/api/boards/:id", async (c) => {
  const id = boardIdFrom(c.req.param("id"));
  requireSession(c);
  await authenticateOrganizer(c, id);
  await deletePhotoPrefix(c.env.PHOTOS, id);
  await c.env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(id).run();
  return c.body(null, 204);
});

app.post("/api/events", async (c) => {
  enforceSameOrigin(c);
  const sessionId = requireSession(c);
  const payload = objectPayload(await parseJson(c, 1024));
  const name = payload.name;
  if (typeof name !== "string" || !clientEventNames.has(name)) {
    throw new ApiError("invalid_event", 400);
  }
  const boardId =
    payload.boardId === null || payload.boardId === undefined
      ? null
      : boardIdFrom(cleanText(payload.boardId, 32, 32));
  await recordEvent(c.env, name, sessionId, boardId, qaRequest(c));
  return c.json({ accepted: true }, 202);
});

app.get("/health", (c) => c.json({ ok: true }));

app.notFound((c) => {
  if (c.req.path.startsWith("/api/") || !/\.[a-z0-9]{2,8}$/iu.test(c.req.path)) {
    return c.html(
      <Layout
        canonical={`${canonicalOrigin}/`}
        description="指定されたページは見つかりませんでした。"
        noindex
        title="見つかりません｜合鍵板"
      >
        <main class="not-found">
          <div class="lock-plate" aria-hidden="true">
            <span></span>
            <i></i>
          </div>
          <h1>この板は見つかりません。</h1>
          <a class="home-link" href="/">
            新しい板を作る
          </a>
        </main>
      </Layout>,
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
  }
  console.error("unhandled_error", {
    message: error instanceof Error ? error.message : String(error),
    requestId: c.get("requestId"),
  });
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env) => {
  const expired = await env.DB.prepare(
    "SELECT id FROM boards WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
  )
    .bind(nowSeconds())
    .all<{ id: string }>();
  for (const board of expired.results) {
    await deletePhotoPrefix(env.PHOTOS, board.id);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM boards WHERE expires_at <= ?").bind(nowSeconds()),
    env.DB.prepare("DELETE FROM product_events WHERE created_at <= ?").bind(
      nowSeconds() - eventLifetime,
    ),
    env.DB.prepare("DELETE FROM creation_limits WHERE day < date('now', '-2 days')"),
    env.DB.prepare("DELETE FROM write_limits WHERE day < date('now', '-2 days')"),
  ]);
};

export { app, scheduled };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Bindings>;
