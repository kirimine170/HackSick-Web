# HackSick Website

分野横断的技術コミュニティ「HackSick」の公式Webサイトです．Astroによる静的サイトとして構築し，Cloudflare Pagesでの公開を想定しています．

## Requirements

- Node.js 22.12.0以上
- npm

`.nvmrc` で推奨Node.jsバージョンを指定しています．

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

## Build

```bash
npm run check
npm run build
npm run preview
```

ビルド成果物は `dist/` に出力されます．

## Directory structure

```text
public/              公開画像，favicon，robots.txt
src/assets/          ブランドの原本素材
src/components/      再利用可能なUI
src/data/            共通情報，外部リンク，イベント情報
src/layouts/         HTMLレイアウトと共通SEO
src/pages/           ページと404
src/styles/          サイト全体のスタイル
```

## Environment Variables

初期実装では環境変数を必要としません．将来追加する場合は `.env.example` と実際の環境を同期し，秘密情報を `PUBLIC_` 変数へ格納しないでください．

## Cloudflare Pages

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`

GitHub連携後，まず `*.pages.dev` のPreview Deploymentで確認してください．その後 `hacksick.com` をCustom Domainへ追加し，`www.hacksick.com` からcanonical hostへ301 redirectを設定します．Google Workspaceで利用するMX，SPF，DKIM，DMARC等のDNSレコードには触れないでください．

## Content update

外部リンクと直近イベントの情報は `src/data/site.ts` に集約しています．Discordの招待URLは各connpassイベントページで案内し，このリポジトリへ固定URLを直接記載しません．
