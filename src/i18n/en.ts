export default {
  siteTitle: "Yangshi",
  nav: {
    home: "Home",
    projects: "Projects",
    about: "About",
    contact: "Contact"
  },
  ui: {
    switchZh: "中文",
    switchEn: "English"
  },
  home: {
    greeting: "Yangshi",
    role: "Computer Enthusiast",
    bio: "A middle-school student who just loves computers. I tinker with small websites and tools in my spare time, purely because it's fun.",
    viewProjects: "View Projects",
    aboutMe: "About Me",
    // 统计
    stats: [
      { value: "6+", label: "Years of Experience" },
      { value: "4+", label: "Projects Deployed" },
      { value: "6+", label: "Core Technologies" },
      { value: "100%", label: "Commitment" }
    ],
    // 技能
    skillsHeading: "Technical Mastery",
    skills: [
      { name: "Scratch", level: 100 },
      { name: "Python", level: 80 },
      { name: "HTML", level: 75 },
      { name: "Lume", level: 100 }
    ],
    arsenalHeading: "Arsenal",
    arsenal: [
      { name: "IDEA", icon: "idea" },
      { name: "Python", icon: "python" },
      { name: "VSCode", icon: "vscode" },
      { name: "Git", icon: "git" },
      { name: "Astro", icon: "astro" },
      { name: "AstraEditor", img: "/icons/astraeditor.svg" }
    ],
    visitors: "Visitors"
  },
  projects: {
    heading: "Projects",
    subtitle: "Selected Works",
    archive: "View Archive",
    items: [
      {
        name: "LumeOS",
        desc: "A pretend operating system that runs in a browser tab — window manager, shell, virtual filesystem. No backend, no framework, no build step.",
        tags: ["Vanilla JS", "Canvas", "UI"],
        link: "/LumeOS/"
      },
      {
        name: "Lume",
        desc: "My personal static site / web framework experiment built for creative sites.",
        tags: ["Astro", "TypeScript", "SSG"],
        link: "https://yangshidanny.github.io/lume/"
      },
      {
        name: "Minecraft Survival Kit",
        desc: "A Fabric modpack for Minecraft 26.1.2 built around survival and QoL: Sodium + Iris + Lithium for performance, Baritone for pathing, SeedCrackerX for seed cracking, Chunky for pre-generating terrain. Drop the zip into any launcher that imports Modrinth/CurseForge packs.",
        tags: ["Minecraft", "Fabric", "Modpack", "72 MB"],
        link: "/downloads/survivalkits_modpack/"
      }
    ]
  },
  download: {
    heading: "Download",
    title: "Minecraft Survival Kit",
    lead: "This 72 MB pack is hosted on GitHub, not on this site — a static host is the wrong place to serve a file that size. Pick a source below and your browser fetches it straight from there.",
    sizeLabel: "Size",
    filesLabel: "File",
    shaLabel: "SHA-256",
    sourceHeading: "Download source",
    sourceNote: "Latency is measured live from your browser. Under ~400 ms is comfortable; if GitHub times out, use the mirror.",
    probing: "measuring…",
    fastest: "fastest",
    slowest: "slowest",
    unreachable: "unreachable",
    remeasure: "Measure again",
    directLabel: "GitHub · direct",
    directHint: "Best outside mainland China. Occasionally slow or blocked inside it.",
    mirrorLabel: "gh-proxy.com · mirror",
    mirrorHint: "Public GitHub proxy. Usually the reliable choice from mainland China.",
    downloadBtn: "Download .zip",
    copyBtn: "Copy link",
    copied: "Copied",
    copyPrompt: "Copy this link:",
    warningHeading: "Heads up",
    warningBody: "The mirror is a third-party public proxy. It works with any GitHub URL, but it does see the traffic that passes through it — if you would rather not, use the direct link.",
    insideHeading: "What's inside",
    insideItems: [
      "Sodium + Iris + Lithium — rendering and tick performance",
      "Baritone — automated pathing and mining routes",
      "SeedCrackerX — recover the world seed in-game",
      "Chunky — pre-generate terrain before you explore",
      "A tuned set of QoL mods for survival play"
    ],
    installHeading: "How to install",
    installSteps: [
      "Download the zip from either source.",
      "Open your launcher — Prism, MultiMC, ATLauncher and CurseForge all work.",
      "Use \"Import modpack\" / \"Add instance from file\" and pick the zip.",
      "Launch it. The launcher pulls the remaining mods on first run."
    ],
    verifyHeading: "Verify the download",
    verifyNote: "Compare the hash after downloading — it should match exactly.",
    back: "All projects"
  },
  about: {
    heading: "About",
    tagline: "Engineering Digital Reality.",
    intro: "I'm a middle-school student in Shanghai who's into computers as a whole — web pages, static site generators, and all kinds of random front-end experiments. I build things for fun, not for a job title.",
    ageLabel: "Age",
    location: "Location: Shanghai",
    focusLabel: "Focus",
    focusText: "I'm currently a middle-school student in Shanghai, so I don't get much time online and can only tinker with simple development projects here and there. In my free time I also enjoy playing games like Minecraft. That said, I've been coding for over 6 years now.",
    masteryHeading: "Tech Stack",
    mastery: [
      { area: "Frontend", items: [
        { name: "Astro", icon: "astro" },
        { name: "React", icon: "react" },
        { name: "Tailwind CSS", icon: "tailwind" }
      ]},
      { area: "Backend", items: [
        { name: "Node.js", icon: "nodejs" },
        { name: "Python", icon: "python" }
      ]},
      { area: "Tools", items: [
        { name: "Git", icon: "git" },
        { name: "VSCode", icon: "vscode" },
        { name: "IDEA", icon: "idea" },
        { name: "AstraEditor", img: "/icons/astraeditor.svg" }
      ]}
    ]
  },
  contact: {
    heading: "Contact",
    title: "Say something.",
    intro:
      "Found a bug, have an idea, or just want to talk? Leave a message below — I read every one of them. Replies may be slow since I'm usually at school.",
    formLabel: "Message Form",
    nameLabel: "Name",
    namePlaceholder: "Optional",
    emailLabel: "Email",
    emailPlaceholder: "Optional — so I can write back",
    messageLabel: "Message",
    messagePlaceholder: "Type anything here…",
    submit: "Send Message",
    sending: "Sending…",
    success: "Got it. Thanks for writing!",
    error: "Couldn't send. Please try again later.",
    empty: "Please write a message first.",
    fallbackNote: "Direct email instead",
    directLabel: "Elsewhere",
    githubLabel: "GitHub",
    directEmail: "Email"
  }
}
