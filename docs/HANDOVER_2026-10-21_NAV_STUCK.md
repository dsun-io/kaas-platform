# 交接 · 排障：侧边栏点击"无响应/不跳转"（2026-10-21）

> 触发：生产 `https://kaas.powervoy.com`，从 `/quotes?tab=pricing` 点侧边栏「产品」→ URL 不变、
> 页面不变；用户同时观察到"接口调用正常"。
> **本文只做取证与交接，未改任何代码**（用户 2026-10-21 指令："定位原因以后创建交接文档并推送，不用动手"）。
> 上一手交接入口：[HANDOVER_2026-10-21_CUTOVER.md](./HANDOVER_2026-10-21_CUTOVER.md)。

## 0. 结论速览

| 项 | 判定 | 证据强度 |
|---|---|---|
| 生产前端产物 = **Windows 本机构建**的静态导出（逐字节相同） | ✅ 已证实 | SHA256/MD5 相同 + 段文件名特征 |
| Next 16 静态导出的**逐段预取文件（per-segment）命名错误**：导出成 `__next.!KGFwcCk/products/__PAGE__.txt`（正斜杠→目录），客户端请求的是 `__next.!KGFwcCk.products.__PAGE__.txt`（点号）⇒ **全站逐段预取 404** | ✅ 已证实（5 条路由全中） | 线上 URL 探测 + Next 源码 |
| 导航"整页 RSC"通道（`/xxx.txt?_rsc=…` + `next-router-state-tree`） | ✅ 正常：200 `text/plain`、build id 一致、ETag 与本地产物相同 | curl 实测 |
| "点了完全不动"的直接根因 | ⚠️ **未定论**（缺浏览器侧证据：console / network / hydration） | 需下一步仪器 |

**一句话**：产物层已经确证有一个真实缺陷（逐段预取全 404），它足以让客户端路由"看起来卡住/很慢"；
但**是否就是"完全不跳转"的唯一原因尚未证实**——因为整页 RSC 回退通道是好的，
按 Next 代码此时应退化为整页软导航。下一手请先按 §5 抓一次浏览器证据再动手改。

## 1. 现场与复跑命令

```powershell
# ① 生产页面/RSC 载荷 vs 本地导出产物（两者应逐字节相同 —— 实测就是相同）
curl.exe -sS -o $env:TEMP/p.html https://kaas.powervoy.com/products
Get-FileHash $env:TEMP/p.html -Algorithm SHA256
Get-FileHash frontend/out/products.html -Algorithm SHA256     # 45FFD5A1…4494D（一致）

curl.exe -sS -o $env:TEMP/p.txt 'https://kaas.powervoy.com/products.txt?_rsc=raAVn0mdyfcSFU0T' ^
  -H 'rsc: 1' -H 'next-url: /products'
Get-FileHash $env:TEMP/p.txt -Algorithm MD5 -ErrorAction SilentlyContinue
# 实测：prod_md5 = f18e2f1f3741be02b40644cbf390b5ff = 本地 frontend/out/products.txt

# ② 逐段预取文件：客户端请求的"点号"名字 vs 线上实际存在的"目录"形态
curl.exe -sS -o NUL -w '%{http_code} %{size_download}
' 'https://kaas.powervoy.com/products/__next.!KGFwcCk.products.__PAGE__.txt'   # 404 13
curl.exe -sS -o NUL -w '%{http_code} %{size_download}
' 'https://kaas.powervoy.com/products/__next.!KGFwcCk/products/__PAGE__.txt'  # 200 8072
```

实测（2026-10-21 17:5x，LAX PoP，`CF-Cache-Status: HIT`）：

| 路由 | 客户端请求（点号，**404**） | 线上实际存在（斜杠→目录，**200**） |
|---|---|---|
| /products | `/products/__next.!KGFwcCk.products.__PAGE__.txt` | `/products/__next.!KGFwcCk/products/__PAGE__.txt` (8072B) |
| /quotes | `/quotes/__next.!KGFwcCk.quotes.__PAGE__.txt` | `/quotes/__next.!KGFwcCk/quotes/__PAGE__.txt` (8751B) |
| /customers | 404 | 200 (8482B) |
| /dashboard | 404 | 200 (9221B) |
| /trade-docs | 404 | 200 (8483B) |
| 任意路由 `__next._tree.txt` | — | 200（377B 等，正常） |

本地导出目录同样如此（`Get-ChildItem frontend/out/products -Recurse`）：

```
frontend/out/products/__next._full.txt
frontend/out/products/__next._tree.txt
frontend/out/products/__next.!KGFwcCk\products\__PAGE__.txt   <-- 名字里带反斜杠 = Windows 路径分隔符
```

## 2. 机理（Next 16.4.2 源码三处，版本在 `node_modules/.pnpm/next@16.4.2…/node_modules/next/dist/`）

1. **导出侧写文件名**（`export/index.js:755-759`）：
   ```js
   const segmentPaths = await collectSegmentPaths(segmentsDir)      // path.relative() 得到分隔符
   const segmentPath = '/' + segmentFileSrc.slice(0, -RSC_SEGMENT_SUFFIX.length)
   const segmentFilename = convertSegmentPathToStaticExportFilename(segmentPath)
   ```
   `collectSegmentPathsImpl` 用的是 **`path.relative()`**（`export/index.js:807`）——
   **在 Windows 上返回 `!KGFwcCk\products\__PAGE__`（反斜杠）**，Linux 上返回正斜杠。

2. **文件名编码**（`shared/lib/segment-cache/segment-value-encoding.js:82-84`）：
   ```js
   function convertSegmentPathToStaticExportFilename(segmentPath) {
     return `__next${segmentPath.replace(/\//g, '.')}.txt`   // 只替换 '/'，反斜杠原样保留
   }
   ```
   ⇒ Windows 上生成的文件名里残留 `\`，落到磁盘就是**多级目录**，
   与"点号扁平名"不是同一个文件。

3. **客户端请求侧**（`client/components/segment-cache/cache.js:1417-1437, 2512-2520`）：
   请求键由 `appendSegmentRequestKeyPart` 拼成（`/(app)` 段先被 base64url 成 `!KGFwcCk`），
   再用**同一个** `convertSegmentPathToStaticExportFilename`，但入参里是 **`/`**：
   ```
   requestKey = '!KGFwcCk/products/__PAGE__'  ->  __next.!KGFwcCk.products.__PAGE__.txt
   ```
   ⇒ 导出侧与请求侧**只在 Windows 上分叉**。Linux/CI 构建（`deploy.yml` 的 ubuntu-latest）不会有这个问题。

> 直观复算（本机 Node，依赖已就位）：
> ```powershell
> node -e "const e=require('./node_modules/.pnpm/next@16.4.2_@babel+core@7.2_a777e1e313661c9c0170134d548c3c6c/node_modules/next/dist/shared/lib/segment-cache/segment-value-encoding.js'); const r=e.ROOT_SEGMENT_REQUEST_KEY; const a=e.appendSegmentRequestKeyPart(r,'children','!KGFwcCk'); const p=e.appendSegmentRequestKeyPart(a,'children','products'); const g=e.appendSegmentRequestKeyPart(p,'children','__PAGE__'); console.log('client =',e.convertSegmentPathToStaticExportFilename(g)); console.log('export(Win) =',e.convertSegmentPathToStaticExportFilename('/!KGFwcCk\\\\products\\\\__PAGE__'));"
> # client = __next.!KGFwcCk.products.__PAGE__.txt
> # export(Win) = __next.!KGFwcCk\products\__PAGE__.txt
> ```

## 3. 为什么"接口正常却不跳转"还没定论

Next 的客户端导航有**两条**通道：

| 通道 | 触发 | 线上实测 |
|---|---|---|
| 逐段预取（per-segment，PPR 风格） | `<Link prefetch>` 悬停/挂载时；命中后**软导航几乎零成本** | ❌ 全部 404（§1） |
| 整页 RSC 回退（`fetchServerResponse`） | 逐段缺失/被拒 → 直接拉整页 `.txt` | ✅ 200、`text/plain`、build id `4Dmti-K92OFNDpa379m6W` 与 HTML 载荷一致、ETag `91a2ada6…` 与本地文件相同 |

按 `client/components/segment-cache/cache.js`：预取 404 ⇒ `rejectSegmentEntriesIfStillPending(...)` +
`REJECTION_BACKOFF_MS` 退避；导航随后走 `navigateToUnknownRoute` → `fetchServerResponse` → 应**正常软导航**。
所以：**"完全不跳转"还缺一环解释**。可能的补充原因（未验证，勿当结论）：

- **H1 hydration 未成功**：客户端 chunk 出错 ⇒ Link 的 `onClick` 已 `preventDefault` 但路由更新抛错 ⇒
  URL 完全不变（若未 hydrate，反而是原生跳转，会换页）。查 console 是否有 hydration/ChunkLoadError。
- **H2 预取 404 风暴的连带效应**：侧边栏每个 `<Link prefetch={true}>`（`frontend/src/components/layout/sidebar.tsx:166`）
  都会走逐段预取；首屏 20+ 个 404 + 退避可能让"点下去几秒内无反应"→ 用户体感为"无响应"。
- **H3 老 Service Worker 残留**：`frontend/out/mockServiceWorker.js` 会随产物上线；历史上访问过
  mock 模式的浏览器可能仍注册着 SW，拦截同源请求（prod 是 `NEXT_PUBLIC_API_MODE=real`，正常不会启动它）。
- **H4 路由守卫"看起来没动"**：`WorkstationGate` 命中"该工位未开通"时渲染引导页——但 URL 会变，
  与"URL 不变"现象不符，仅作排除项。

## 4. 处置建议（让下一手照着做，不必重新取证）

**优先级 P0（几乎肯定要修，且能立刻验证）——用 Linux 产物构建前端静态导出：**

1. 首选：直接用 CI 的 `build-frontend` job 产物（`deploy.yml` = ubuntu-latest，天然正斜杠），
   下载 artifact 后 `cd backend/ts-worker; pnpm wrangler deploy`；不要"本机 Windows 构建 + 直接 deploy"。
2. 次选：本机用 WSL / 容器跑 `NEXT_EXPORT=1 pnpm build`。
3. 验证口径（部署后应全部 200）：
   ```powershell
   curl.exe -sS -o NUL -w '%{http_code}\n' 'https://kaas.powervoy.com/products/__next.!KGFwcCk.products.__PAGE__.txt'
   curl.exe -sS -o NUL -w '%{http_code}\n' 'https://kaas.powervoy.com/quotes/__next.!KGFwcCk.quotes.__PAGE__.txt'
   ```
   附带检查：`frontend/out` 下不应再出现任何名字里含 `\` 的文件。

**P1（若部署后仍"完全不跳"）—— 抓浏览器证据，别再靠 curl 猜：**
```ts
// frontend/e2e/ 里临时加一条（或 playwright 脚本）：
page.on('console', m => console.log('[console]', m.type(), m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('response', r => { if (r.url().includes('__next') || r.url().includes('.txt')) console.log('[resp]', r.status(), r.url()); });
await page.goto('https://kaas.powervoy.com/login'); /* 登录 */
await page.goto('https://kaas.powervoy.com/quotes?tab=pricing');
await page.getByRole('link', { name: '产品' }).click();
console.log('URL after click =', page.url());
```
判定：(a) 有 `pageerror`/`ChunkLoadError` ⇒ 修 hydration/分块；(b) 只有 404 且 URL 变了 ⇒ 已修（P0 生效）；
(c) 404 且 URL 不变且无报错 ⇒ 继续查 router 状态机与 SW。

**不建议的绕法**：把侧边栏 `Link` 改成 `prefetch={false}` 或 `window.location`。那只是掩盖
"产物命名错误"，还丢掉 SPA 体验；根因在构建环境，改构建即可。

## 5. 附：本次已核实"不是原因"的项

- ❌ 不是 RSC 载荷缺失/内容错：`/products.txt` 与本地产物 MD5 相同。
- ❌ 不是 build id 不匹配：HTML 与 RSC 载荷里都是 `4Dmti-K92OFNDpa379m6W`。
- ❌ 不是 `text/plain` 不被认：Next 在 `output: "export"` 下显式接受 `text/plain`（`fetch-server-response.js:130-135`）。
- ❌ 不是 API/鉴权/工位订阅：用户反馈接口正常；且 `/api/v1/*` 走 `kaas-edge` → `KERNEL` 透传，与页面路由无关。
- ❌ 不是 CF 缓存规则误伤：`/_next/static/*` 规则不覆盖 `*.txt`（实测 `Cache-Control: public, max-age=0, must-revalidate`）。

## 6. 待办登记

| 项 | 状态 | 触发点 |
|---|---|---|
| 前端导出改由 Linux/CI 构建并重新部署门面 | ⏳ 未做（等用户指令） | 用户确认后执行 §4 P0 |
| 部署后按 §4 验证脚本复验 5 条路由 | ⏳ 未做 | 同上 |
| 若仍不跳：按 §4 P1 抓浏览器证据 | ⏳ 未做 | P0 无效时 |
| 立规：**Windows 构建的静态导出不得直接 deploy**（写进 AGENTS.md 部署段） | ⏳ 未做 | 下一次文档同步 |

---

*取证与撰写：lead（DSH AI），2026-10-21 18:0x。仅文档，未改动代码；未部署。*
