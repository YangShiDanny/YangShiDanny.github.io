# yangshidanny.github.io

Personal site — Astro 7 static build, English at the root and Chinese under `/zh/`.
Also ships **LumeOS**, a pretend operating system that runs entirely in a browser tab
(`public/LumeOS/`, hand-written vanilla JS, no build step, no backend).

```sh
npm install
npm run dev      # localhost:4321
npm run build    # → dist/
```

Node **>= 22.23.4** is required by Astro 7. The `dev`/`build` scripts in `package.json`
point at an absolute `/usr/bin/node` so they work on this machine regardless of
which Node is first in `PATH`.

---

## Layout

```
src/
  pages/            routes — index, projects, about, contact, downloads/, plus /zh/*
  i18n/             all copy lives in en.ts / zh.ts; add a key to both or it won't typecheck
  components/       BaseLayout, TopNav, Starfield, Cursor
public/
  LumeOS/           the fake OS: index.html + css/ + js/ + assets/
  downloads/        large downloadable files (see note below)
scripts/
  build-ime-dict.cjs   compiles scripts/data/ime-dict.json → public/LumeOS/assets/ime-dict.txt
  data/                build-time input, not published
```

## Large files and the download page

`public/downloads/survivalkits_modpack.zip` is 69 MB and lives in git. Pages serves it
like any other static asset, but the download page at `/downloads/survivalkits_modpack/`
deliberately **does not** link to it — a static host is the wrong place to push that
much traffic. Instead the page measures latency to two candidates and points the
download at whichever answers first:

| Source | URL shape |
| :-- | :-- |
| GitHub direct | `raw.githubusercontent.com/<repo>/main/public/downloads/<file>` |
| gh-proxy.com | `https://gh-proxy.com/` + the GitHub URL |

Note the `public/` segment: the repo path is `public/downloads/…`, while the
*served* path is `/downloads/…`. Getting that wrong yields a 404 on the raw link.

Latency is probed with a `Range: bytes=0-1` request, so measuring costs two bytes
rather than the whole file. `Range` is also why the mirror works at all — it proxies
the redirect chain properly.

## Python runtime (WASM)

LumeOS can install a Python runtime into the browser's own storage. Nothing is
bundled with this site and nothing is re-hosted; the terminal command fetches the
official Pyodide minimal distribution and parks it in IndexedDB.

```sh
# inside LumeOS → Terminal
py setup     # downloads pyodide-core (~6.4 MB), once per browser
py status    # what's installed, how much space it uses
py remove    # delete it
```

Two reasons for IndexedDB instead of `localStorage`: `localStorage` caps out around
5 MB and stores UTF-16 strings, so a 6.4 MB binary would blow the quota and waste
~37% on base64; IndexedDB stores `Blob`/`ArrayBuffer` natively against the much
larger disk quota.

`py run` is not wired up yet — the downloader and storage layer are done, the
execution bridge is a later pass.

## Credits

This site stands on other people's work. Thank you:

- **[Pyodide](https://github.com/pyodide/pyodide)** (MPL-2.0) — CPython and the
  standard library compiled to WebAssembly. The `pyodide-core-*.tar.bz2` release
  asset is what LumeOS downloads. Without it, "install Python in a browser tab"
  would still be a dubious weekend project instead of a working one.
- **[rime-ice / 雾凇拼音](https://github.com/iDvel/rime-ice)** (MPL-2.0) — the source
  of the Chinese IME dictionary. `scripts/build-ime-dict.cjs` reshapes it into a
  compact line format; the word frequencies and the pinyin table are all theirs.
- **[Cal Sans](https://github.com/calcom/font)** (OFL-1.1) and
  **[Inter](https://github.com/rsms/inter)** (OFL-1.1) — display and body type,
  subset and self-hosted.
- **[Astro](https://astro.build)** (MIT) — static build.
- **[gh-proxy](https://gh-proxy.com)** — the public proxy the download page offers
  as a mirror for readers whose network cannot reach GitHub directly.

License texts for the bundled third-party components are listed in the LumeOS
**Licence** window (menu bar → `LumeOS 1.0 nebula · x86_64` → Licence).
