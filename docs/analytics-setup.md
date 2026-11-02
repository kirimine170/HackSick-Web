# アクセス解析の導入・確認手順

2026-11-02．この変更では計測タグを追加しておらず，データ収集は開始していない．既存の計測管理画面の数値も取得していない．

## 何をどこで見るか

| 知りたいこと | 主な手段 | 指標・確認単位 |
| --- | --- | --- |
| どのページが何回見られたか | GA4 | ページパス別の表示回数・アクティブユーザー |
| X・connpass・Googleなど，どこから来たか | GA4＋告知URLのUTM | セッションの参照元／メディア，キャンペーン |
| connpass・タコシェなどへのクリック数 | GA4の離脱クリック | clickイベント，link_domain，link_url，ページパス |
| Google検索での表示・クリック・検索語 | Search Console | ページ別・クエリ別の表示回数，クリック，CTR |
| ページ表示・参照元・表示性能の補助確認 | Cloudflare Web Analytics | Path，Referrer，ページ表示・表示性能 |

GA4の表示回数とSearch Consoleの検索クリックは定義が異なるため，数値を一致させる目的では使わない．広告ブロックや同意状態などで，ブラウザ側の計測が欠けることがある．計測開始前の閲覧やクリックを後から復元することはできない．

## 1．GA4の計測を用意する

1. 運営が管理するGoogleアカウントで[GA4の初期設定](https://support.google.com/analytics/answer/9304153?hl=ja)を行い，プロパティとWebデータストリームを作る．本番のURLを`https://hacksick.com`にする．
2. ストリームの測定ID（`G-...`）と管理担当者を記録する．Googleタグを本番レイアウトへ追加する実装を行う．現在のリポジトリにはタグがないため，管理画面の設定だけでは収集されない．
3. 本番ホストだけを測定対象にし，localhost，previewブランチ，`*.pages.dev`の確認アクセスを混ぜない．タグマネージャーと直接埋め込みの二重設置を避ける．
4. [拡張計測機能](https://support.google.com/analytics/answer/9216061?hl=ja)の「離脱クリック」を有効にする．サイト内検索・フォーム操作など，不要な項目は無効にする．フォームへの入力内容，メールアドレス，氏名をイベントへ渡さない．
5. 収集項目・利用するサービス・管理担当を利用者向けの説明へ反映し，同意の運用を決めてから有効化する．この手順書自体はタグ導入や同意設定の完了を意味しない．

## 2．ページ別の閲覧を見る

GA4の「ページとスクリーン」で，ページパスを使って集計する．まず次の3ページとトップ，Eventsを確認する．タイトルを変更してもパスで比較できるようにする．

- `/news/anokoto-no-kankeisei-ni-tsuite/`
- `/works/anokoto-no-kankeisei-ni-tsuite/`
- `/creators/matsumi-koen/`

「表示回数」は閲覧数であり，購入数やユニーク人数ではない．人物の人数を見るときはユーザー指標を別に確認する．

## 3．流入元をそろえる

[トラフィック獲得レポート](https://support.google.com/analytics/answer/12923437?hl=ja)で「セッションの参照元／メディア」を見る．新規ユーザーの最初の流入を見る[ユーザー獲得とは区別する](https://support.google.com/analytics/answer/14731736?hl=ja)．

外部へ掲載する告知リンクには，[UTMの3項目](https://support.google.com/analytics/answer/10917952?hl=ja-JP)を付ける．表記を小文字へ統一する．

```text
Xの告知
https://hacksick.com/news/anokoto-no-kankeisei-ni-tsuite/?utm_source=x&utm_medium=social&utm_campaign=anokoto_tacoche

connpassのイベント説明から
https://hacksick.com/?utm_source=connpass&utm_medium=referral&utm_campaign=hacksick_lt
```

アプリ内ブラウザやリダイレクトなどで，参照元が欠落することがある．X由来の全件をReferrerだけで判定しない．サイト内部の相互リンクにはUTMを付けない．Google自然検索へ手動でUTMを付ける必要はない．

## 4．外部リンクのクリックを見る

[離脱クリック](https://support.google.com/analytics/answer/9216061?hl=ja)は`click`イベントに`link_domain`と`link_url`などを含む．「探索」で行にページパス・リンクドメイン・リンクURL，値にイベント数を置き，`event_name = click`かつ`outbound = true`で絞る．必要なディメンションはGA4の管理画面で利用可能なものを確認する．

- connpass：`hacksick.connpass.com`など，実際のリンクドメインで集計する．
- タコシェ：`taco.shop-pro.jp`への案内リンクと，将来の商品URLを分けて集計する．現在は本作の商品URLが未公開のため，店頭・通販案内へのクリックとして扱う．
- X：`x.com`への離脱クリックと，Xから流入したセッションを区別する．

クリックは申込み・購入の完了を意味しない．自サイトで確認できるのは外部サイトへの遷移まで．タコシェでの購入数やconnpassでの参加申込み数は，各サービスの権限・提供データが必要になる．同じクリックを標準の`click`と独自イベントで二重集計しない．

## 5．Google検索を確認する

Search Consoleに本番ドメインを登録し，所有権を確認する．既存のDNS設定・メール用レコードを変更せず，必要な検証レコードだけを追加する．`https://hacksick.com/sitemap-index.xml`を登録し，[検索パフォーマンス](https://support.google.com/webmasters/answer/7576553?hl=ja)でページ・検索語・期間を比較する．previewはnoindexを維持する．

本番公開後は対象3URLのHTTP 200，canonical，noindexがないことを確認する．現在の本番に新しいURLがまだない場合は，previewで動くことだけを根拠にインデックス登録を依頼しない．

## 6．導入後の動作確認

1. リアルタイム表示で本番へのテスト閲覧が届くことを確認する．
2. UTM付きのX用・connpass用URLを別々のセッションで開き，流入元が区別されるか確認する．
3. connpassとタコシェのリンクを各1回押し，ページとリンク先を含む`click`が各1回届くことを確認する．フォームの入力内容が送られていないことも確認する．
4. localhostと公開previewで同じ操作をし，本番用のイベントが増えないことを確認する．
5. 標準レポートへの処理を待って，週次でページ別閲覧，流入元，外部クリックをCSVで保存する．管理画面のレイアウトや処理時間はアカウント・設定によって異なる．

[Cloudflare Web Analyticsのディメンション](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/)は，既存のCloudflare配信における補助確認に使える．上記の外部クリック分析をCloudflareのページ表示数だけで代用しない．
