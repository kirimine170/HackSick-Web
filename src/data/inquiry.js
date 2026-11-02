// Shared by the form and Pages Function so labels，categories and delivery routes agree．
export const inquiryRoutes = {
  organization: {
    label: "HackSickへの相談",
    email: "shizuku.kirimine@hacksick.com",
    description: "共同企画，協賛，会場提供，登壇希望，研究連携，取材など，HackSick全体へのご相談を承ります．運営よりご連絡します．",
    categories: [
      { value: "collaboration", label: "共同企画・連携" },
      { value: "sponsorship", label: "協賛・スポンサー" },
      { value: "venue", label: "会場提供" },
      { value: "speaking", label: "登壇・イベント参加" },
      { value: "research", label: "研究連携" },
      { value: "press", label: "取材・メディア掲載" },
      { value: "other", label: "その他・一般のお問い合わせ" },
    ],
  },
  creator: {
    label: "クリエイターへの仕事の依頼",
    email: "hsap@hacksick.com",
    description: "写真撮影，作品制作，書籍・作品の取扱いなど，クリエイターへの仕事依頼を承ります．HackSickの創作支援プロジェクトHSAPが窓口となります．",
    categories: [
      { value: "photography", label: "写真撮影" },
      { value: "production", label: "制作・共同企画" },
      { value: "distribution", label: "書籍・作品の取扱い" },
      { value: "press", label: "取材・メディア掲載" },
      { value: "other", label: "その他" },
    ],
  },
};
