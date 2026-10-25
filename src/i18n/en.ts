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
      }
    ]
  },
  about: {
    heading: "About",
    tagline: "Engineering Digital Reality.",
    intro: "I'm a middle-school student in Shanghai who's into computers as a whole — web pages, static site generators, and all kinds of random front-end experiments. I build things for fun, not for a job title.",
    ageLabel: "Age",
    birth: "Born: 2011-09-27",
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
