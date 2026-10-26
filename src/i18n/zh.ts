export default {
  siteTitle: "羊史",
  nav: {
    home: "首页",
    projects: "项目",
    about: "关于",
    contact: "联系"
  },
  ui: {
    switchZh: "中文",
    switchEn: "English"
  },
  home: {
    greeting: "羊史",
    role: "电脑爱好者",
    bio: "一名初中生，单纯喜欢折腾电脑。平时抽空做点小网站和小工具，纯粹是觉得好玩。",
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
      { name: "AstraEditor", img: "/icons/astraeditor.svg" }
    ],
    visitors: "访客"
  },
  projects: {
    heading: "项目",
    subtitle: "精选作品",
    archive: "查看归档",
    items: [
      {
        name: "LumeOS",
        desc: "一个跑在浏览器标签页里的伪操作系统——窗口管理器、终端、虚拟文件系统。没有后端，没有框架，也不需要构建。",
        tags: ["原生 JS", "Canvas", "界面"],
        link: "/LumeOS/"
      },
      {
        name: "Lume",
        desc: "我自己做的静态站点/网页框架实验，面向创意站点开发。",
        tags: ["Astro", "TypeScript", "SSG"],
        link: "https://yangshidanny.github.io/lume/"
      },
      {
        name: "MC 生存模式辅助工具包",
        desc: "给 Minecraft 26.1.2 做的 Fabric 整合包，围绕生存与体验优化：Sodium + Iris + Lithium 提性能，Baritone 跑图、SeedCrackerX 破种子、Chunky 预生成地形。把 zip 丢进任意支持 Modrinth/CurseForge 整合包导入的启动器即可。",
        tags: ["Minecraft", "Fabric", "整合包", "72 MB"],
        link: "/downloads/survivalkits_modpack.zip",
        download: true
      }
    ]
  },
  about: {
    heading: "关于",
    tagline: "构建数字现实。",
    intro: "我是上海的初中生，对电脑本身更感兴趣——网页、静态站点生成器，还有各种随手瞎折腾。做东西是因为好玩，不是为了什么头衔。",
    ageLabel: "年龄",
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
        { name: "AstraEditor", img: "/icons/astraeditor.svg" }
      ]}
    ]
  },
  contact: {
    heading: "联系",
    title: "说点什么。",
    intro:
      "发现 bug、有想法，或者只是想聊两句？在下面留个言吧，每条我都会看。平时要上学，回复可能会慢一点。",
    formLabel: "留言表单",
    nameLabel: "称呼",
    namePlaceholder: "选填",
    emailLabel: "邮箱",
    emailPlaceholder: "选填，方便我回信",
    messageLabel: "留言",
    messagePlaceholder: "想说什么都可以…",
    submit: "发送消息",
    sending: "发送中…",
    success: "收到啦，谢谢你的留言！",
    error: "发送失败，请稍后再试。",
    empty: "请先写点内容。",
    fallbackNote: "或者直接发邮件",
    directLabel: "其他联系方式",
    githubLabel: "GitHub",
    directEmail: "邮箱"
  }
}
