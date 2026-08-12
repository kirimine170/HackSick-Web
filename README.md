# HackSick Website

HackSick公式Webサイトです．HackSickを，異なる分野の人が集まり，知識や問いを共有し，ProjectやWorkを生み出していくための場所として紹介します．

Production：<https://hacksick.com>

## Project Overview

このサイトは，次の役割をひとつの活動サイクルとして扱います．

- Community Website
- Activity Archive
- Event Portal
- Project Archive
- Works Portfolio
- Creator Directory
- Partnership / Sponsor Interface

分野はページ階層ではなくTagとして扱います．Technology，Research，AI，Art，Photography，Music，Literature，Design等を，同じContentへ複数付与できます．

## Tech Stack

- Astro 6
- TypeScript
- Astro Content Collections
- Static Site Generation
- npm
- Cloudflare Pages

ReactやVue等のClient Frameworkは使用していません．表示に必要なHTMLとCSSを静的生成します．

## Requirements

- Node.js 22.12.0以上
- npm

`.nvmrc` で推奨Node.jsバージョンを指定しています．

## Local Development

```bash
npm install
npm run dev
```

Astroが表示するLocal URLをブラウザで開いてください．

## Type Check / Build

```bash
npm run check
npm run build
npm run check:links
npm run preview
```

静的Buildは `dist/` へ出力されます．

## Deployment

Cloudflare Pagesの設定は次の通りです．

```text
Production branch: main
Build command: npm run build
Build output directory: dist
Root directory: /
```

GitHubの `main` へのpushを起点に，Cloudflare Pagesが `hacksick.com` へDeployします．既存のCloudflare DNSおよびGoogle Workspace用DNSレコードは変更しないでください．

## Directory Structure

```text
public/
├─ images/works/             Workの公開画像
├─ favicon.png
├─ og.png
└─ robots.txt

src/
├─ assets/brand-source/      HackSickロゴの原本
├─ components/               再利用可能なAstro Component
├─ content/
│  ├─ activities/            活動Archive
│  ├─ creators/              Creator Profile
│  ├─ events/                Event
│  ├─ projects/              継続Project
│  └─ works/                 制作物
├─ content.config.ts         Collection Schema
├─ data/site.ts              Site設定・外部URL
├─ layouts/                  共通Layout・SEO／OGP
├─ pages/                    Route
└─ styles/                   Global Style
```

## Content Management

Event，Project，Work，Creator，Activityは `src/content/` 配下のMarkdownとして管理します．Schemaは `src/content.config.ts` にあり，`npm run check` と `npm run build` の両方で検証されます．

外部URLと正式な問い合わせ先は，繰り返し使うものを `src/data/site.ts` に集約してください．Event固有のconnpass URLやWork固有の販売URLは，各ContentのFrontmatterに記載します．

実績，固有名詞，日程，会場，Creator Profileは，確認できた情報だけをProductionへ掲載してください．UI確認用Dummy Dataを公開しないでください．

## Definition of Done

- `npm run check`，`npm run build`，`npm run check:links` が成功している．
- 生成された全ページを監査し，ユーザー向け本文に `TODO`，`TBA`，`Dummy`，`Placeholder`，内部確認待ち，運営確認待ち等の開発・確認用文言が残っていない．
- 未確定情報を掲載する場合は，会場：調整中，詳細は後日公開，Coming soon等，利用者向けの自然な表現にする．
- Emailは正式な問い合わせ・協業・取材・協賛，DiscordはCommunity参加，connpassはEvent情報・参加登録，XはSNS・告知として，サイト全体で役割を統一する．
- ContactとFooterから正式な問い合わせ導線へ到達できる．

## Content Schema

### Event

主なField：`title`，`description`，`startDate`，`endDate`，`location`，`status`，`tags`，`project`，`registrationUrl`，`organizers`，`partners`，`sponsors`，`thumbnail`，`featured`．

`status` は `upcoming`，`ongoing`，`finished` のいずれかです．終了後もMarkdownとDetail URLを残します．

### Project

主なField：`title`，`description`，`status`，`startDate`，`endDate`，`tags`，`thumbnail`，`featured`，`events`，`works`，`creators`，`externalLinks`．

Projectは，複数のEvent，Work，Creator，Activityを束ねる継続的な企画です．単発EventはProjectとして登録しません．

### Work

主なField：`title`，`description`，`type`，`tags`，`releaseDate`，`firstPresentedAt`，`thumbnail`，`images`，`creators`，`projects`，`events`，`credits`，`externalLinks`，`purchaseUrl`，`featured`．

技術成果と芸術作品を分けず，すべてWorkとして登録します．

### Creator

主なField：`name`，`profile`，`profileImage`，`fields`，`tags`，`works`，`projects`，`events`，`achievements`，各種外部URL，`featured`．

CreatorはHackSick運営が選出し，本人確認と承諾が完了した情報だけを掲載します．Creator Submission Form，Self Registration，Creator管理画面は実装していません．

### Activity

主なField：`title`，`description`，`date`，`type`，`tags`，`event`，`project`，`externalUrl`．

ActivityはEvent Detailではなく，過去の実績を時系列で残すArchive Entryです．

## Adding an Event

1．`src/content/events/<slug>.md` を作成する．
2．FrontmatterをEvent Schemaに合わせる．
3．関連Projectの `events` と，必要ならCreatorの `events` に同じslugを追加する．
4．実績として残す場合は `src/content/activities/` にActivityも追加する．
5．`npm run check` と `npm run build` を実行する．

## Adding a Project

1．`src/content/projects/<slug>.md` を作成する．
2．関連するEvent，Work，CreatorのslugをFrontmatterへ記載する．
3．相互参照先のContentにもProject slugを追加する．
4．`npm run check` と `npm run build` を実行する．

## Adding a Work

1．画像を `public/images/works/` へ追加する．
2．`src/content/works/<slug>.md` を作成する．
3．Typeと複数Tag，Credit，確認済みの外部URLを記載する．
4．関連するProject，Event，Creatorのslugを相互に追加する．
5．`npm run check` と `npm run build` を実行する．

## Adding a Creator

1．本人の承諾を得る．
2．公開情報・本人提供情報を整理し，本人に掲載内容を確認する．
3．`src/content/creators/<slug>.md` を作成する．
4．確認できないProfileや実績を推測で記載しない．
5．関連するProject，Work，Eventのslugを相互に追加する．
6．`npm run check` と `npm run build` を実行する．

サイト上にCreator登録・申請導線はありません．
