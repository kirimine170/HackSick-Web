export const site = {
  name: "HackSick",
  title: "HackSick｜分野横断的技術コミュニティ",
  description:
    "技術を愛するすべての人へ．分野を越えて，創りたいものを語り，造り，分かち合う技術コミュニティです．",
  url: "https://hacksick.com",
  locale: "ja_JP",
} as const;

export const navigation = [
  { label: "About", href: "/#about" },
  { label: "Philosophy", href: "/#philosophy" },
  { label: "Activities", href: "/#activities" },
  { label: "Latest", href: "/#latest" },
] as const;

export const links = {
  connpass: "https://hacksick.connpass.com/",
  note: "https://note.com/hacksick",
  x: "https://x.com/HackSick_8949",
} as const;

export const latestEvent = {
  number: "07",
  title: "第7回 HackSick LT会",
  theme: "AI・LLM 〜人類の労働奪ってくれました…？〜",
  date: "2026-07-25",
  displayDate: "2026.07.25 SAT.",
  venue: "秋葉原No21／オンライン",
  url: "https://hacksick.connpass.com/event/400238/",
} as const;
