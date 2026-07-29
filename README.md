# 合鍵板

URLの合い鍵を渡した小さな団体だけで、30日間の連絡板を共有する日本語Web
サービスです。

- 参加者アカウント、公開一覧、メール通知なし
- お知らせ・質問・メモ、返信、確認印、検索
- 1投稿1枚の写真を端末内で再圧縮
- 共有鍵・管理鍵の生値はURL fragmentだけに保持
- 掲示板と写真は30日後に削除、編集用JSONを管理者が保存可能

## Development

```powershell
npm install --cache .npm-cache
npm run check
npm test
npm run build
```

Runtime: Cloudflare Workers / D1 / R2, Hono / Hono JSX, Vite+, TypeScript.
