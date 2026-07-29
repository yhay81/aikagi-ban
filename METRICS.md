# Metrics

- `visited`: 公開トップを開いた
- `board_created`: 掲示板を作成した
- `board_opened`: 合い鍵で掲示板を開いた
- `post_created`: 投稿を作成した
- `comment_created`: 返信した
- `acknowledged`: 確認印を付けた
- `photo_added`: 写真つき投稿を作成した
- `board_exported`: 管理者が編集用JSONを書き出した
- `returned`: 別の日に再訪した

匿名ブラウザID、任意の掲示板ID、JST日付、QAフラグ以外をイベントへ含めません。
`x-aikagi-qa: 1` は実利用集計から除外し、イベントは45日後に削除します。
