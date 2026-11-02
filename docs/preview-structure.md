# Preview構成案

対象：previewブランチ／https://preview.hacksick-web.pages.dev/

- News：公式発表．RELEASE，EVENT，MEDIA，INFORMATIONに分類し，正式なプレスリリースにはpressReleaseを設定する．
- Works：作品の恒久ページ．価格，刊行日，販売先などの正式情報を管理する．
- Creators：人物紹介，関連Work，関連News，仕事依頼フォームへの導線．
- Projects／Events：継続企画とイベント開催情報．
- Activities：過去の実績．トップとFooterから案内する．
- note：制作背景，インタビュー，イベントレポート．Newsから読み物として案内する．
- Contact：HackSick全体への相談と，HSAP経由の仕事依頼を分けた共通フォーム．`?route=organization`，`?route=creator&creator=marmite-daikon-oroshi`で事前選択する．

漫画短編集『あのことの関係性について』は，2026-11-02に提供された作品紹介・著者紹介・陳列写真をもとに，作品ページとプレス記事を作成．全四編の紹介，サークル「きぐうのきわみ」，合同文芸同人誌『文画』の制作歴と現在の休止をクリエイターページにも反映．同一の添付写真は重複掲載せず，異なる2点をWebP化して使用．仕様，価格，刊行日，購入先は未掲載．新刊発売や特定店舗での販売状況は発表していない．

2026-11-02更新：connpassの第8〜10回をEvents／Activities／HackSick LT／代表プロフィールへ追加．第8回は最終案内に合わせオンラインもくもく会，第9回にはnoteレポート，第10回には最終公開ページの登壇情報を反映．SAKURA DEEPTECH SHIBUYAの公式案内に基づき，11/5共催イベントと申込先Lumaを追加．次回イベントと新着Newsにも表示する．未確認の参加人数は掲載していない．

## フォーム

Previewではデフォルトでデモモード．入力→確認→テスト完了はブラウザ内で処理し，入力内容を送信・保存しない．実送信用APIは設定が揃わない限り503で拒否する．宛先はサーバー側で固定し，organizationは既存のshizuku.kirimine@hacksick.com，creatorはhsap@hacksick.com．利用者の入力値を配送先や送信元にしない．送信元アドレスはCONTACT_FROMの認証済みアドレスを両窓口で使用する．

`/contact/test/`は疎通確認を終えたため削除済み．確認画面の表示時にTurnstileを描画し，入力へ戻った場合はウィジェットを破棄する．代表プロフィールは本番と同じkirimine-shizukuを正規URLに統一し，旧Previewのshizuku-kirimineから転送する．

実受付へ移行する際は，個人情報方針の運用担当・保存期間・外部サービス利用を確定し，privacyページの方針案を更新する．Resendの送信ドメイン認証とTurnstileの許可ホストを設定する．Cloudflare Pagesの対象環境に以下を設定する．Productionへの反映は別途行う．

| 変数 | 場所 | 用途 |
| --- | --- | --- |
| PUBLIC_CONTACT_MODE=live | Build環境 | 実送信UIを有効にする |
| PUBLIC_TURNSTILE_SITE_KEY | Build環境 | 公開サイトキー |
| CONTACT_ENABLED=true | Runtime | API受付を有効にする |
| CONTACT_FROM | Runtime | 認証済みドメインの送信元 |
| RESEND_API_KEY | Runtime secret | メール送信用キー |
| TURNSTILE_SECRET_KEY | Runtime secret | 不正送信対策の検証キー |

キーをGitへ保存しない．実際の送信確認は所有者の指示のもとで行う．この試作ではサービス登録，DNS変更，実メール送信は行っていない．
