export const site = {
  name: "HackSick",
  title: "HackSick｜創りたいを、造りたい。",
  description:
    "異なる分野の人が集まり、知識や問いを共有し、プロジェクトや作品を生み出していくための場所です。",
  url: "https://hacksick.com",
  locale: "ja_JP",
} as const;

export const navigation = [
  { label: "About", href: "/about/" },
  { label: "Activities", href: "/activities/" },
  { label: "Projects", href: "/projects/" },
  { label: "Works", href: "/works/" },
  { label: "Events", href: "/events/" },
  { label: "Creators", href: "/creators/" },
  { label: "Join", href: "/join/" },
] as const;

export const links = {
  connpass: "https://hacksick.connpass.com/",
  note: "https://note.com/hacksick",
  noteAbout: "https://note.com/hacksick/n/nfe71d58d2512",
  x: "https://x.com/HackSick_8949",
  github: "https://github.com/kirimine170/HackSick-Web",
} as const;

const contactEmail = "shizuku.kirimine@hacksick.com";

export const contact = {
  email: contactEmail,
  emailHref: `mailto:${contactEmail}`,
} as const;

export const organization = {
  name: "HackSick",
  representative: "霧峰 雫",
  area: "東京都内／オンライン",
} as const;

export const tagLabels: Record<string, string> = {
  Technology: "Technology",
  Engineering: "Engineering",
  Research: "Research",
  AI: "AI",
  Robotics: "Robotics",
  Software: "Software",
  Hardware: "Hardware",
  Security: "Security",
  Art: "Art",
  Illustration: "Illustration",
  Photography: "Photography",
  Film: "Film",
  Music: "Music",
  Literature: "Literature",
  Design: "Design",
  Game: "Game",
  Culture: "Culture",
};

export const statusLabels = {
  upcoming: "Upcoming",
  ongoing: "Ongoing",
  finished: "Finished",
  planned: "Planned",
  completed: "Completed",
  paused: "Paused",
} as const;

export const eventFormatLabels = {
  online: "オンライン開催",
  offline: "オフライン開催",
  hybrid: "ハイブリッド開催",
} as const;

export const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(date);

export const formatDateTime = (date: Date) =>
  new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  }).format(date);
