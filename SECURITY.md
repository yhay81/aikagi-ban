# Security

脆弱性は公開Issueへ詳細を書かず、GitHubのPrivate vulnerability reportingから
報告してください。

- 共有鍵・管理鍵はURL fragmentからAPI headerへ渡す
- D1にはSHA-256 hashだけを保存し、一定時間比較を行う
- 内容APIはsame-origin、CSP、noindex、no-storeで保護する
- 写真はJPEG magic byte、700KB上限を検査し、R2を公開しない
- 投稿・返信・作成には日次上限を設ける
