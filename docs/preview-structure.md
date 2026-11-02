# Preview構成案

対象：previewブランチ／https://preview.hacksick-web.pages.dev/

- News：公式発表．RELEASE，EVENT，MEDIA，INFORMATIONに分類し，正式なプレスリリースにはpressReleaseを設定する．
- Works：作品の恒久ページ．価格，刊行日，販売先などの正式情報を管理する．
- Creators：人物紹介，関連Work，関連News，仕事依頼フォームへの導線．
- Projects／Events：継続企画とイベント開催情報．
- Activities：過去の実績．トップとFooterから案内する．
- note：制作背景，インタビュー，イベントレポート．Newsから読み物として案内する．
- Contact：クリエイターを選べる共通フォーム．`?creator=marmite-daikon-oroshi`などで事前選択する．

書籍『あのことの関係性について』はタイトルと作者のみを使用した構成見本．書影，あらすじ，仕様，価格，刊行日，購入先は未掲載．Newsの例には2026-09-15の既存プロフィール公開を使用し，新刊発売の事実は作成していない．

## フォーム

Previewではデフォルトでデモモード．入力→確認→テスト完了はブラウザ内で処理し，入力内容を送信・保存しない．本番用APIは設定が揃わない限り503で拒否する．メールアドレスは固定のhsap@hacksick.comへ配送し，利用者の入力値を配送先や送信元にしない．

`/contact/test/`は実メール送信の疎通確認専用．通常フォームのdemo設定に関係なく実送信するが，サーバー側のCONTACT_ENABLEDと全認証情報，実際のTurnstile検証は必要．テストデータのみを使う．確認画面の表示時にTurnstileを描画し，入力へ戻った場合はウィジェットを破棄する．

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
