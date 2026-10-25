export default {
  siteTitle: "羊史",
  nav: {
    home: "首页",
    projects: "项目",
    about: "关于"
  },
  ui: {
    switchZh: "中文",
    switchEn: "English"
  },
  home: {
    greeting: "羊史",
    role: "全栈开发者",
    bio: "一名热爱开发的少年，制作创意网站与开发工具。我专注于把干净的前端体验与扎实、高性能的后端结合起来。",
    viewProjects: "查看项目",
    aboutMe: "关于我",
    stats: [
      { value: "6+", label: "年开发经验" },
      { value: "4+", label: "已部署项目" },
      { value: "6+", label: "核心技术" },
      { value: "100%", label: "投入度" }
    ],
    skillsHeading: "技术能力",
    skills: [
      { name: "Scratch", level: 100 },
      { name: "Python", level: 80 },
      { name: "HTML", level: 75 },
      { name: "Lume", level: 100 }
    ],
    arsenalHeading: "工具箱",
    arsenal: [
      { name: "IDEA", icon: "idea" },
      { name: "Python", icon: "python" },
      { name: "VSCode", icon: "vscode" },
      { name: "Git", icon: "git" },
      { name: "Astro", icon: "astro" },
      { name: "AstraEditor", img: "https://editors.astras.top/images/logo-white.svg" }
    ],
    visitors: "访客"
  },
  projects: {
    heading: "项目",
    subtitle: "精选作品",
    archive: "查看归档",
    items: [
      {
        name: "Lume",
        desc: "我自己做的静态站点/网页框架实验，面向创意站点开发。",
        tags: ["Astro", "TypeScript", "SSG"],
        link: "https://github.com/YangShiDanny/lume"
      }
    ]
  },
  about: {
    heading: "关于",
    tagline: "构建数字现实。",
    intro: "我喜欢网页开发、静态站点生成器以及前端相关的各种实验。我专注于打造可扩展的 Web 应用和干净、直观的界面。",
    ageLabel: "年龄",
    birth: "生日：2011-09-27",
    location: "所在地：上海",
    focusLabel: "我在做什么",
    focusText: "目前我在上海的一所初中上学，平时没什么时间上网，只能抽空做一些简单的开发小项目。课余时间我也喜欢玩 MC（Minecraft）这类游戏。不过算下来，我接触编程也已经有 6 年多的经验了。",
    masteryHeading: "技术栈",
    mastery: [
      { area: "前端", items: [
        { name: "Astro", icon: "astro" },
        { name: "React", icon: "react" },
        { name: "Tailwind CSS", icon: "tailwind" }
      ]},
      { area: "后端", items: [
        { name: "Node.js", icon: "nodejs" },
        { name: "Python", icon: "python" }
      ]},
      { area: "工具", items: [
        { name: "Git", icon: "git" },
        { name: "VSCode", icon: "vscode" },
        { name: "IDEA", icon: "idea" },
        { name: "AstraEditor", img: "https://editors.astras.top/images/logo-white.svg" }
      ]}
    ]
  }
}
