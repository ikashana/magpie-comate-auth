// 文心快码 Baidu Comate → magpie：账号卡片（会员 / 席位积分 / 增购 / 赠送）+ 15 个模型。
//
// 百度搭子的 Pro/Max 会员与文心快码的会员权益是同一套：搭子下的订单，积分落在
// Comate 这边（comate.baidu.com 个人中心的「席位积分」）。搭子自己的配额接口看不到
// 这份积分，所以在 magpie 里加一个 Comate 账号卡片，才能看见会员那 25,000 分。
//
// 模型通道走的是 Comate 插件那套真实 HTTP API（不是 zulu CLI）：
//   GET  /api/key/valid/<license>                       验票
//   POST /autowork/v2/conversation   → conversationId    建会话
//   POST /autowork/v2/task           → taskId            建任务
//   POST /autowork/v2/execute        → SSE（ANSWER.delta）执行
// 认证只需要把 license 放进 login-name 头，没有签名 / 设备绑定，所以不需要起进程，
// 也不自己 listen 端口。请求由 magpie 的 auth.loader.fetch 交进来（官方插件教程），
// 插件只做翻译。会话 id 用 chat.headers 的 sessionID，不要靠自己起的服务活着。
//
// 本插件只读 magpie 交给 getAuth() 的登录态。用量缓存和会话索引写在插件入参
// directory（magpie 的配置目录）下，不写 magpie 的配置。

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"

const PROVIDER_ID = "comate"
const PROVIDER_NAME = "文心快码 Comate"

const BASE = "https://comate.baidu.com"
const USER_CENTER = "https://comate.baidu.com/zh/user"
const LOGIN_URL =
  "https://passport.baidu.com/v2/?login&tpl=mn&u=" + encodeURIComponent("https://comate.baidu.com/zh/user")

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// Comate 靠百度 passport 的 BDUSS 认人；BDUSS_BFESS 是同一份值的 HTTPS 版本。
const REQUIRED_COOKIES = ["BDUSS"]

const cardText = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)

// magpie 的凭据库在 <data>/plugin-auth.json。插件可能是原地加载（plugin add <路径>），
// 也可能是拷进 <data>/plugins/node_modules/<name>/，两种都要找得到：
// 先看 magpie 自己报的数据目录 / 可执行文件位置，再看插件自身位置，最后看 cwd。
function magpieAuthFiles() {
  const dirs = []
  if (process.env.MAGPIE_DATA) dirs.push(process.env.MAGPIE_DATA)
  for (const p of [process.execPath, process.argv?.[0], process.argv?.[1]]) {
    if (!p || !/magpie/i.test(String(p))) continue
    const d = dirname(String(p))
    dirs.push(d, join(d, ".."))
  }
  try {
    const pd = dirname(pathOf(new URL(import.meta.url)))
    // 装进 node_modules 时：<data>/plugins/node_modules/<name>/ → 上溯三级是 <data>
    dirs.push(resolve(pd, "../../.."), resolve(pd, "../../../.."))
  } catch {}
  try {
    dirs.push(process.cwd())
  } catch {}

  const seen = new Set()
  const out = []
  for (const d of dirs) {
    if (!d) continue
    for (const cand of [join(d, "data", "plugin-auth.json"), join(d, "plugin-auth.json")]) {
      const norm = String(cand).replace(/\\/g, "/")
      if (seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

function pathOf(u) {
  // Windows: file:///C:/somewhere/data/... → /C:/somewhere/... → C:/somewhere/...
  let p = decodeURIComponent(u.pathname)
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}

// 读 magpie 里任意 provider 的 cookies（只读）。用于「复用已登录的百度账号」。
function readMagpieCookies(providerIds = ["dumate", "comate"]) {
  for (const file of magpieAuthFiles()) {
    if (!existsSync(file)) continue
    let data
    try {
      data = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    for (const id of providerIds) {
      const entry = data?.[id]
      const cookies = Array.isArray(entry?.cookies) ? entry.cookies : null
      if (!cookies?.length) continue
      if (!cookies.some((c) => c?.name === "BDUSS")) continue
      return { cookies, accountId: entry.accountId, name: entry.name }
    }
  }
  return null
}

function parseCookieString(raw) {
  const out = []
  for (const part of String(raw ?? "").split(";")) {
    const s = part.trim()
    if (!s) continue
    const i = s.indexOf("=")
    if (i <= 0) continue
    const name = s.slice(0, i).trim()
    const value = s.slice(i + 1).trim()
    if (!name || !value) continue
    out.push({ name, value, domain: ".baidu.com" })
  }
  // 去重，后者覆盖前者
  const map = new Map()
  for (const c of out) map.set(c.name, c)
  return [...map.values()]
}

function buildCookieHeader(cookies, hostname = "comate.baidu.com") {
  const h = String(hostname).toLowerCase()
  const pick = (cookies ?? []).filter((c) => {
    const name = String(c?.name ?? "").toLowerCase()
    // console.bce.baidu.com 的 bce-* 会话属于百度智能云控制台；带着它们访问
    // comate.baidu.com 会让服务端走 BCE 鉴权并判「没有授权」。x-bce-login-redirect-url
    // 这几个不在其内，要留着。
    if (name.startsWith("bce-")) return false
    const d = String(c?.domain ?? "").toLowerCase().replace(/^\./, "")
    if (!d) return true
    return h === d || h.endsWith("." + d)
  })
  return pick.map((c) => `${c.name}=${c.value}`).join("; ")
}

function missingCookies(cookies, required) {
  return required.filter((n) => !(cookies ?? []).some((c) => c?.name === n))
}

function signInError(message) {
  const err = new Error(message || "文心快码登录态已失效，请重新登录")
  err.signIn = "expired"
  return err
}

async function getJsonOnce(path, cookieHeader, timeoutMs) {
  const res = await fetch(BASE + path, {
    method: "GET",
    headers: {
      Cookie: cookieHeader,
      "User-Agent": UA,
      Accept: "application/json",
      Referer: USER_CENTER,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw signInError(`Comate 拒绝访问（HTTP ${res.status}），请重新登录`)
  if (/^\s*</.test(text)) throw signInError("Comate 返回了登录页，登录态已失效")
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Comate 返回非 JSON（HTTP ${res.status}）`)
  }
  const status = String(json?.status ?? "").toUpperCase()
  if (status === "UNAUTHORIZED" || status === "NOT_LOGIN" || status === "FORBIDDEN") {
    // Comate 在短时间内被连打几次就会回「没有授权!」，并不是登录真的失效：
    // 所以这里不带 signIn，免得 magpie 把账号标成过期；过几分钟自然恢复。
    const err = new Error(`Comate 暂时拒绝请求（${cardText(json?.message) || status}），稍后再刷新`)
    err.code = "FLAKY_UNAUTHORIZED"
    throw err
  }
  if (status && status !== "OK") throw new Error(`Comate 接口错误（${path}）：${cardText(json?.message) || status}`)
  return json?.data
}

// 不重试：Comate 的「没有授权!」就是请求打太快了，再补一次只会更糟。
async function getJson(path, cookieHeader, { timeoutMs = 15000 } = {}) {
  return getJsonOnce(path, cookieHeader, timeoutMs)
}

// 卡片刷新很频繁，Comate 又不喜欢同一登录态连发：同一份 cookies 的用量 10 分钟内复用。
// CLI 每次调用是新进程（模块级 Map 会丢），所以再落一份到磁盘，GUI 和 CLI 共用。
const usageCache = new Map()
const CACHE_TTL_MS = 600_000
const CACHE_FILE = "comate-usage-cache.json"
const SESSION_FILE = "comate-sessions.json"
// 插件函数入参 directory 才是 magpie 配置目录。bun 宿主的 execPath 在
// data/cache/bun 下，按可执行文件位置去找 plugin-auth.json 会找丢。
let pluginDataDir = ""

function dataDir() {
  if (pluginDataDir) return pluginDataDir
  for (const f of magpieAuthFiles()) {
    try {
      if (existsSync(f)) return dirname(f)
    } catch {}
  }
  return ""
}

function readDiskCache() {
  try {
    const d = dataDir()
    if (!d) return null
    const p = join(d, CACHE_FILE)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, "utf8"))
    return j?.at && j?.data ? j : null
  } catch {
    return null
  }
}

function writeDiskCache(data) {
  try {
    const d = dataDir()
    if (!d) return
    writeFileSync(join(d, CACHE_FILE), JSON.stringify({ at: Date.now(), data }), "utf8")
  } catch {}
}

const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const packOf = (p) => ({
  total: num(p?.totalPoints),
  used: num(p?.usedPoints),
  available: p?.availablePoints == null ? num(p?.totalPoints) - num(p?.usedPoints) : num(p?.availablePoints),
})

// "2026-12-12 23:59:59" → ISO；解析不了返回 null
function parseCnTime(s) {
  if (!s) return null
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).toISOString()
}

async function loadIcon() {
  for (const rel of ["./icon.png", "./icon.svg"]) {
    try {
      const p = pathOf(new URL(rel, import.meta.url))
      if (!existsSync(p)) continue
      const buf = readFileSync(p)
      const mime = rel.endsWith(".svg") ? "image/svg+xml" : "image/png"
      return `data:${mime};base64,${buf.toString("base64")}`
    } catch {}
  }
  return "data:image/svg+xml;base64," + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2932E1"/><text x="32" y="42" font-size="28" font-family="sans-serif" fill="#fff" text-anchor="middle">码</text></svg>`,
  ).toString("base64")
}

const pluginIcon = await loadIcon()

// ───────────────────────────── 模型：直连 Comate HTTP API，经 auth.loader.fetch 翻译 ─────────────────────────────
//
// 不包 zulu，也不 listen 端口。modelId 从 list-model 取一次，服务端换版本时再更新。


// modelId 是 Comate 服务端认的完整 key（<type>_<hash>），从 `zulu list-model` 取一次，
// 会随服务端版本变；对不上时用 modelType 前缀兜底，再不行就报错让用户重跑 list-model。
//
// context 是 Comate 服务端回的真实上下文上限（每次响应的 usage 里带 contextLimit），
// 2026-11 实测值见 README「上下文窗口（实测）」。此前这里对 15 个模型一律写 128000，
// 把 200K~1.024M 的模型全低估成 128K，网关卡在「128K + 8K 输出预留」上，
// 长会话里会把这些模型从候选里剔掉（表现为「不参与：这个请求超出它 128K 的上下文窗口」）。
// 新增模型时务必先测一次，不要沿用默认值。
const MODELS = [
  { id: "deepseek-v4-flash", modelId: "deepseek-v4-flash_a8668ea86c3d40e7ad1f8ee45715d447", label: "Deepseek V4 Flash", vision: false, context: 1024000 },
  { id: "deepseek-v4-pro", modelId: "deepseek-v4-pro_4ba5277b630243be9eeb19fe48f853fa", label: "Deepseek V4 Pro", vision: false, context: 1024000 },
  { id: "deepseek-v4.1-flash", modelId: "deepseek-v4.1-flash_4827e158760447029e6594bb2b1ab066", label: "Deepseek V4.1 Flash", vision: true, effort: ["low", "high", "max"], context: 1000000 },
  { id: "ernie-5.5-flash-preview", modelId: "ernie-5.5-flash-preview_996d9d76bb7c45ecbff286216aaeeab2", label: "ERNIE 5.5 Flash Preview", vision: true, context: 1000000 },
  { id: "glm-4.7-fc", modelId: "glm-4.7-fc_0b87452a03394418b5c8d5468deff6c7", label: "GLM-4.7", vision: false, context: 200000 },
  { id: "glm-5-turbo-fc", modelId: "glm-5-turbo-fc_6748c832242b4bcb8f715c7c7902d1ad", label: "GLM-5-Turbo", vision: false, context: 200000 },
  { id: "glm-5.1", modelId: "glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9", label: "GLM-5.1", vision: false, context: 256000 },
  { id: "glm-5.2", modelId: "glm-5.2_50c584482e9d47edbbe47938a88b56b1", label: "GLM-5.2", vision: false, context: 1000000 },
  { id: "glm-5.3", modelId: "glm-5.3_37c550fc6d5b4fb2825abc2c1c88a6b3", label: "GLM-5.3", vision: false, effort: ["low", "high", "max"], context: 1000000 },
  { id: "glm-5.3-flash", modelId: "glm-5.3-flash_805131a9381a4940ba0f2d90cad0e7eb", label: "GLM-5.3-Flash", vision: true, context: 1000000 },
  { id: "glm-5v-turbo", modelId: "glm-5v-turbo_ea9e4f222f0a40b281953ebcb6981dda", label: "GLM-5v-Turbo", vision: true, context: 200000 },
  { id: "kimi-k2.6-oneapi", modelId: "kimi-k2.6-oneapi_123e4567e89b12d3a456426614174000", label: "Kimi-K2.6", vision: true, context: 256000 },
  { id: "minimax-m2.5-fc", modelId: "minimax-m2.5-fc_c99ea14f526548a8bc28717d4e854123", label: "MiniMax M2.5", vision: false, context: 200000 },
  { id: "minimax-m3", modelId: "minimax-m3_a8f465fbedb942efadace88370ad7ff1", label: "MiniMax M3", vision: true, context: 512000 },
  { id: "minimax-m2.7-fc", modelId: "minimax-m2.7-fc_047f123f661c414bb253c05b605c391e", label: "MiniMax-M2.7", vision: false, context: 200000 },
]

const modelOf = (name) => MODELS.find((m) => m.id === name || m.label === name) ?? MODELS[0]

function modelEntry(m) {
  return [
    m.id,
    {
      id: m.id,
      name: m.label,
      // api.id 是发给上游的 model id（Comate 认的 <type>_<hash>），和展示用的 id 不同
      api: { id: m.modelId, npm: "@ai-sdk/openai-compatible" },
      // context 用上表实测值；没有测过的模型退回 128K（宁可低估，也不要让网关把
      // 装不下的请求塞给上游）。output 服务端不回传，沿用 8192。
      limit: { context: m.context ?? 128000, output: m.output ?? 8192 },
      capabilities: {
        reasoning: true,
        toolcall: true,
        attachment: !!m.vision,
        input: { text: true, image: !!m.vision },
      },
      ...(m.effort ? { variants: Object.fromEntries(m.effort.map((e) => [e, {}])) } : {}),
    },
  ]
}

function selfDir() {
  try {
    return dirname(pathOf(new URL(import.meta.url)))
  } catch {
    return ""
  }
}

// ── Comate 真实 HTTP API ──────────────────────────────────────────
// 认证只要把 license 放进 login-name / Uuap-login-name 头，没有签名、没有设备绑定，
// 所以不需要像 CLI 那样每次 spawn 一个进程。实测单轮 1.4 秒、1 万字长文 2.0 秒。
const API_HEADERS = (license) => ({
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "login-name": license,
  "Uuap-login-name": license,
  "X-Source": "COMATE",
  "plugin-version": "zulucli-4.13.0",
  "x-skip-fcnap": "yes",
  "Accept-Language": "zh-CN,zh",
  "User-Agent": "axios/1.16.1",
})
const apiBase = (license) => ({ username: license, ide: "zulucli", ideVersion: "1.7.21", pluginVersion: "4.13.0" })

let licenseCache = { value: "", at: 0 }

// license 就是 /api/user 返回的那串 UUID，和额度卡片共用同一份 cookie。
async function getLicense(cookieHeader) {
  if (licenseCache.value && Date.now() - licenseCache.at < 3600_000) return licenseCache.value
  const data = await getJsonOnce("/api/user", cookieHeader, 15000)
  const lic = data?.license ?? data?.data?.license ?? ""
  if (!lic) throw new Error("拿不到 license（/api/user 没有返回 license 字段）")
  licenseCache = { value: lic, at: Date.now() }
  return lic
}

async function apiPost(license, path, body, { timeoutMs = 60000, signal } = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { ...API_HEADERS(license), "X-Trace-Id": randomUUID() },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let j = null
  try {
    j = JSON.parse(text)
  } catch {}
  if (!r.ok) throw new Error(`${path} ${r.status} ${text.slice(0, 160)}`)
  return j ?? {}
}

const mimeOf = (p) => {
  const e = String(p).split(".").pop().toLowerCase()
  if (e === "jpg" || e === "jpeg") return "image/jpeg"
  if (e === "webp") return "image/webp"
  if (e === "gif") return "image/gif"
  return "image/png"
}

// 图片要先上传换 file id，execute 时靠 contexts[type=IMAGE] 引用。
async function uploadImage(license, filePath) {
  const buf = readFileSync(filePath)
  const mime = mimeOf(filePath)
  const name = String(filePath).split(/[\\/]/).pop() || "image.png"
  const r = await apiPost(
    license,
    "/api/aidevops/autocomate/rest/autowork/v1/file/upload",
    { fileName: name, contentType: mime, scene: "Composer", fileData: `data:${mime};base64,${buf.toString("base64")}` },
    { timeoutMs: 120000 },
  )
  return { id: r?.data?.id, name }
}

function estimateTokens(s) {
  const text = String(s ?? "")
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f)) cjk++
  }
  return Math.round(cjk * 0.63 + (text.length - cjk) * 0.3)
}

function contextExceededError() {
  const err = new Error(
    "Comate 上下文已超出可压缩范围（NeedCompressionException）：这次输入太大，压缩后仍装不下，请缩短单条输入或另开会话",
  )
  err.status = 400
  err.code = "context_length_exceeded"
  return err
}

// 一轮对话：建会话（或复用）→ 建任务 → execute；边收 SSE 边把增量交给 onDelta。
// license 由调用方从 getAuth() 取出，这里不再自己翻 plugin-auth.json。
async function callComate({ question, model, conversationId, images = [], toolResults = [], wantTools = false, onDelta, timeoutMs = 300000, license, signal }) {
  if (!license) throw new Error("没有 license：请先在 magpie 登录文心快码")
  const base = apiBase(license)
  const execSignal = signal ?? AbortSignal.timeout(timeoutMs)

  // 图片：先上传拿 id，再在 contexts 里引用
  const contexts = []
  if (images.length && model.vision) {
    const uploaded = []
    for (const p of images) {
      try {
        const u = await uploadImage(license, p)
        if (u?.id) uploaded.push(u)
      } catch {}
    }
    if (uploaded.length) {
      contexts.push({
        type: "IMAGE",
        imageIds: uploaded.map((u) => u.id),
        images: uploaded.map((u) => ({
          id: u.id,
          name: u.name,
          url: `${BASE}/api/aidevops/autocomate/rest/autowork/v1/file/stream/${u.id}?authorization=${license}`,
        })),
      })
    }
  }

  let cid = conversationId
  if (!cid) {
    const conv = await apiPost(license, "/api/aidevops/autocomate/rest/autowork/v2/conversation", { agentId: wantTools ? 1 : 8, ...base }, { signal: execSignal })
    cid = conv?.data?.id
    if (!cid) throw new Error(`建会话失败：${JSON.stringify(conv).slice(0, 200)}`)
  }

  const query = question || (toolResults.length ? "请根据工具结果继续。" : "")

  // 一次执行：建任务 → execute → 收 SSE。needCompression 是「带压缩指令重发」用的，
  // Comate 在上下文接近上限时不会自己压，而是回 NeedCompressionException 让客户端带
  // needCompression=true 重来一次（官方 zulu 客户端的自动重试就是这么做的）。
  const executeOnce = async (needCompression) => {
    const taskId = (
      await apiPost(license, "/api/aidevops/autocomate/rest/autowork/v2/task", {
        agentInfo: wantTools
          ? { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false }
          : { agentName: "Ask", isProjectAgent: false, canInvokeAgents: false, isCustomAgent: false },
        agentId: wantTools ? 1 : 8,
        conversationId: cid,
        signal: {},
        ...base,
      }, { signal: execSignal })
    )?.data?.taskId
    if (!taskId) throw new Error("建任务失败：没拿到 taskId")

    const r = await fetch(BASE + "/api/aidevops/autocomate/rest/autowork/v2/execute", {
      method: "POST",
      headers: { ...API_HEADERS(license), Accept: "text/event-stream", "X-Trace-Id": randomUUID() },
      body: JSON.stringify({
        ...base,
        taskId,
        conversationId: cid,
        agentId: wantTools ? 1 : 8,
        uploadBaseInfo: {
          os: "Windows 10",
          osVersion: "Windows 10",
          extName: "zulucli",
          extVersion: "4.13.0",
          ideType: "zulucli",
          ideName: "zulucli",
          ideVersion: "1.7.21",
          vcsRepo: "",
          vcsBranchName: "",
          username: license,
          license,
          pluginVersion: "4.13.0",
          device: randomUUID(),
          triggerSource: "Agent",
        },
        query,
        modelKey: model.modelId,
        toolUseResults: toolResults,
        contexts,
        subAgents: [],
        sysInfo: {
          os: "Windows 10",
          defaultShell: "cmd.exe",
          homeDir: homedir(),
          installedCommands: [],
          notInstalledCommands: [],
          workspacePath: process.cwd(),
          workspaceRoots: [process.cwd()],
        },
        skillInfos: [],
        hasMcp: false,
        isUserQuery: true,
        isMockQuery: false,
        localIndex: false,
        // 下面这几个字段看着没用，缺了模型会返回空内容——都是 zulu 真实请求里带的。
        // systemReminder 尤其关键：原来照抄 zulu 的「Ask mode / read-only tools」，
        // 模型会去发 FUNCTION_CALL（调 grep/read_file 之类），而这边不实现工具循环，
        // 于是只收到一堆工具调用、拿不到最终文本 → 表现为「回复空白」。
        // 所以这里显式声明「没有工具、只回文本」，把 agent 循环彻底掐掉。
        agentVersion: 12,
        isFirstQuery: !conversationId && !toolResults.length,
        enableMemory: true,
        systemReminder: wantTools
          ? ""
          : "<system-reminder>\nYou are a plain chat assistant. No tools are available in this session.\nDo NOT emit function calls. Answer with text only.\n</system-reminder>",
        extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
        extend: { isMultiWorkspace: false, useWorkflow: false },
        sendMode: "normal",
        agentInfo: wantTools
          ? { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false }
          : { agentName: "Ask", isProjectAgent: false, canInvokeAgents: false, isCustomAgent: false },
        ...(needCompression ? { needCompression: true } : {}),
      }),
      signal: execSignal,
    })
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300)
      const e = new Error(`execute ${r.status} ${detail}`)
      e.compression = /NeedCompressionException/i.test(detail)
      throw e
    }

    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let text = ""
    let err = ""
    let errCompression = false
    let usage = null
    // FUNCTION_CALL 的事件是增量快照，按 tool_use.id 累积最后一个非空 input
    const pending = new Map()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const raw = line.slice(6).trim()
        if (!raw || raw === "[DONE]") continue
        let j
        try {
          j = JSON.parse(raw)
        } catch {
          continue
        }
        const c = j.content
        if (!c) continue
        // 服务端每轮都会回 TOKEN_USAGE（inputTokens/cachedInputTokens/outputTokens），
        // 之前直接丢掉，导致网关侧 token 与缓存统计全是 0。
        if (c.type === "TOKEN_USAGE") {
          const u = c.detail?.usage
          if (u) usage = { ...(usage ?? {}), ...u }
          continue
        }
        if (c.type === "EXCEPTION") {
          err = c.detail?.exceptionMsg ?? c.detail?.message ?? c.text ?? "unknown"
          if (/NeedCompressionException/i.test(JSON.stringify(c))) errCompression = true
        }
        if (c.type === "ANSWER") {
          const d = c.detail?.delta ?? ""
          if (d) {
            text += d
            onDelta?.(d)
          }
        }
        if (String(c.type).startsWith("FUNCTION_CALL")) {
          for (const tu of c.detail?.toolUse ?? []) {
            if (!tu?.id) continue
            const cur = pending.get(tu.id) ?? { name: tu.name ?? "", args: {} }
            if (tu.name) cur.name = tu.name
            if (tu.input && Object.keys(tu.input).length) {
              // Comate 的参数是增量片段（如 "package" 然后 ".json"），空串是收尾标记。
              // 所以字符串拼接、空串跳过，其余类型直接覆盖。
              for (const [k, v] of Object.entries(tu.input)) {
                if (typeof v === "string" && v === "") continue
                if (typeof v === "string" && typeof cur.args[k] === "string" && cur.args[k]) cur.args[k] += v
                else cur.args[k] = v
              }
            }
            pending.set(tu.id, cur)
          }
        }
      }
    }
    // 只把客户端认识的工具交出去。Comate 原始 name/params 记下来，回传 toolUseResults 时要原样还。
    // 交给客户端的参数要改成它工具定义里的字段名（target_directory → path），glob 的 * 不是正则。
    const toolCalls = []
    const dropped = []
    for (const [id, v] of pending.entries()) {
      rememberToolCall(id, v.name, v.args)
      const mapped = TOOL_TO_OPENAI[v.name]
      if (!mapped) {
        if (v.name) dropped.push(v.name)
        continue
      }
      toolCalls.push({ id, name: mapped, arguments: remapArgs(mapped, v.name, v.args) })
    }
    if (err && !text && !toolCalls.length) {
      const e = new Error(err)
      e.compression = errCompression || /NeedCompressionException/i.test(err)
      throw e
    }
    return { text, toolCalls, dropped, usage }
  }

  // 输入特别大时，先直接带 needCompression 发一次：服务端本来就要压，等它回
  // NeedCompressionException 再重试等于白跑一轮。按当前模型上限的 70% 估算，
  // 估低了还有下面的异常重试兜底。
  const compressUpfront = estimateTokens(query) >= Math.round((model.context ?? 1000000) * 0.7)

  let out
  try {
    out = await executeOnce(compressUpfront)
  } catch (e) {
    if (!e?.compression) throw e
    if (compressUpfront) throw contextExceededError()
    // 官方 zulu 客户端的做法：带 needCompression=true 重发一次，让服务端先压缩历史再执行。
    try {
      out = await executeOnce(true)
    } catch (e2) {
      if (e2?.compression) throw contextExceededError()
      throw e2
    }
  }
  return { text: out.text, cid, toolCalls: out.toolCalls, dropped: out.dropped, usage: out.usage }
}

// 把 OpenAI 的 messages 拼成 zulu 的单条 query。zulu 是 agent，不是多轮 chat API。
function toQuery(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === "system" ? "系统设定" : m?.role === "assistant" ? "助手" : "用户"
    let text = ""
    if (typeof m?.content === "string") text = m.content
    else if (Array.isArray(m?.content)) text = m.content.map((c) => c?.text ?? "").join("")
    if (text.trim()) parts.push(`${role}：${text.trim()}`)
  }
  return parts.join("\n\n")
}

// 把「最后一条用户消息」和「之前的历史」拆开。问题本身要留在 -q 里，历史才进附件：
// 反过来的话（元指令进 -q、问题塞附件），模型会把那句元指令当成用户说的话，
// 回答里全是「文件最后一处要求是……因此最后提出的要求是……」这种复述。
function splitQuery(messages) {
  const list = Array.isArray(messages) ? messages : []
  let lastUserIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return { question: "", history: toQuery(list) }
  const question = textOf(list[lastUserIdx]).trim()
  const history = toQuery(list.filter((_, i) => i !== lastUserIdx))
  return { question, history }
}


function readJsonBody(req) {
  return new Promise((r) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        r(JSON.parse(raw || "{}"))
      } catch {
        r({})
      }
    })
  })
}

// ── 多轮：OpenAI 客户端每次都把全量历史发过来，但 zulu 自己有会话，只该收增量。
// 认「这是同一个会话」的办法：上一轮我返回的 assistant 文本，这一轮必然出现在 messages 里。
const REPLY_INDEX = new Map() // hash(assistant 文本) → conversationId
const REPLY_LIMIT = 300

function quickHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return String(h)
}

function textOf(m) {
  if (typeof m?.content === "string") return m.content
  if (Array.isArray(m?.content)) return m.content.map((c) => c?.text ?? "").join("")
  return ""
}

function isNoToolsApology(text) {
  return /纯聊天模式|不能使用工具|没有能直接跑|No tools are available/i.test(String(text || ""))
}

function findCid(messages, sessionKey) {
  loadSessionMap()
  if (sessionKey) {
    const cid = REPLY_INDEX.get("k:" + sessionKey)
    if (cid) return cid
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue
    const text = textOf(messages[i])
    if (!text || isNoToolsApology(text)) continue
    const cid = REPLY_INDEX.get(quickHash(text))
    if (cid) return cid
  }
  return ""
}

function headerGet(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return String(headers.get(name) || headers.get(name.toLowerCase()) || "")
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower && v != null && String(v) !== "") return String(v)
  }
  return ""
}

// 只认明确的会话标识。不用 OpenAI 的 user 字段——那是用户身份，拿它当会话 key 会把不同对话串成一条。
function explicitSession(body, headers) {
  const cands = [
    body?.prompt_cache_key,
    headerGet(headers, "x-magpie-session"),
    headerGet(headers, "x-session-id"),
    headerGet(headers, "x-conversation-id"),
    headerGet(headers, "x-thread-id"),
  ]
  for (const v of cands) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

function loadSessionMap() {
  try {
    const d = dataDir()
    if (!d) return
    const p = join(d, SESSION_FILE)
    if (!existsSync(p)) return
    const j = JSON.parse(readFileSync(p, "utf8"))
    for (const [k, v] of Object.entries(j?.map || {})) {
      if (typeof v === "string" && v && !REPLY_INDEX.has(k)) REPLY_INDEX.set(k, v)
    }
  } catch {}
}

function saveSessionMap() {
  try {
    const d = dataDir()
    if (!d) return
    const map = {}
    let n = 0
    for (const [k, v] of REPLY_INDEX) {
      map[k] = v
      if (++n >= REPLY_LIMIT) break
    }
    writeFileSync(join(d, SESSION_FILE), JSON.stringify({ at: Date.now(), map }), "utf8")
  } catch {}
}

function rememberReply(text, cid, sessionKey) {
  if (!cid) return
  if (text) REPLY_INDEX.set(quickHash(text), cid)
  if (sessionKey) REPLY_INDEX.set("k:" + sessionKey, cid)
  while (REPLY_INDEX.size > REPLY_LIMIT) REPLY_INDEX.delete(REPLY_INDEX.keys().next().value)
  saveSessionMap()
}

// Comate 的参数名和客户端工具定义不一样。原样透传时 target_directory 会被丢掉，glob 的 * 也不是正则。
const ARG_REMAP = {
  search_files: { target_directory: "path", directory: "path", dir: "path", glob: "file_glob" },
  read_file: { file_path: "path", file: "path", filepath: "path", target_file: "path" },
  skill_view: { skill: "name", skill_name: "name", skillName: "name" },
  terminal: { cmd: "command", script: "command" },
  write_file: { file_path: "path", filepath: "path", contents: "content", text: "content" },
  patch: { file_path: "path", filepath: "path", old_str: "old_string", new_str: "new_string" },
  web_search: { q: "query", search_query: "query" },
  web_extract: { url: "urls", link: "urls" },
}

function remapArgs(openaiName, comateName, args) {
  const map = ARG_REMAP[openaiName] || {}
  const out = {}
  for (const [k, v] of Object.entries(args || {})) {
    const nk = map[k] || k
    if (out[nk] == null || out[nk] === "") out[nk] = v
  }
  if (openaiName === "search_files") {
    if (!out.pattern || out.pattern === "*" || out.pattern === "**" || out.pattern === "*.*" || out.pattern === "**/*") out.pattern = "."
    else if (/[*?]/.test(out.pattern)) {
      out.pattern = String(out.pattern)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
    }
    if (/^(Glob|glob_path|list_dir)$/.test(String(comateName))) {
      out.target = "files"
      out.output_mode = "files_only"
    } else if (/grep|content/i.test(String(comateName)) && !out.target) {
      out.target = "content"
    }
  }
  if (openaiName === "web_extract" && typeof out.urls === "string") out.urls = [out.urls]
  return out
}

function boundedHistory(messages) {
  const list = []
  let lastUserIdx = -1
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUserIdx = i
  for (let i = 0; i < messages.length; i++) {
    if (i === lastUserIdx) continue
    const m = messages[i]
    if (!m || m.role === "system" || m.role === "tool") continue
    const t = textOf(m).trim()
    if (!t || isNoToolsApology(t)) continue
    list.push(`${m.role === "assistant" ? "助手" : "用户"}：${t.slice(0, 1500)}`)
  }
  let joined = list.join("\n\n")
  if (joined.length > 12000) joined = joined.slice(-12000)
  return joined
}

function buildQuery({ question, messages, cid, toolResults }) {
  if (cid && (question || toolResults.length)) return question || "请根据工具结果继续。"
  const hist = boundedHistory(messages)
  if (!hist) return question || "请继续。"
  return `${hist}\n\n${question || "请继续。"}`
}

function errResponse(status, message, signIn, code) {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  const type =
    signIn === "expired"
      ? "authentication_error"
      : code === "context_length_exceeded"
        ? "invalid_request_error"
        : "upstream_error"
  return new Response(JSON.stringify({
    error: { message, type, ...(code ? { code } : {}) },
  }), { status, headers })
}

function combineSignal(timeoutMs, outer) {
  const t = AbortSignal.timeout(timeoutMs)
  if (!outer) return t
  if (typeof AbortSignal.any === "function") return AbortSignal.any([t, outer])
  return t
}

async function authForChat(getAuth) {
  if (typeof getAuth !== "function") {
    const d = readMagpieCookies(["comate"])
    if (!d?.cookies?.length) throw signInError("文心快码未登录，请先在 magpie 登录")
    return { cookies: d.cookies, accountId: d.accountId, name: d.name, type: "oauth" }
  }
  const auth = await getAuth()
  if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
    throw signInError("文心快码未登录，请先在 magpie 登录")
  }
  return auth
}

async function licenseFromAuth(auth) {
  const id = String(auth?.accountId || "")
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id
  const header = buildCookieHeader(auth?.cookies || [])
  if (!header) throw signInError("文心快码未登录，请先在 magpie 登录")
  return getLicense(header)
}

// 图片：Hermes / magpie 会用 image_url、input_image、Anthropic image.source 几种形状，
// 也可能放在工具结果里。一律落成临时文件再上传，不要删用户自己的文件。
function imageDir() {
  const d = join(selfDir(), ".tmp")
  try { mkdirSync(d, { recursive: true }) } catch {}
  return d
}

function extOfMime(mime) {
  const e = String(mime || "").toLowerCase()
  if (e.includes("jpeg") || e.includes("jpg")) return "jpg"
  if (e.includes("webp")) return "webp"
  if (e.includes("gif")) return "gif"
  return "png"
}

function writeTempImage(buf, ext) {
  const file = join(imageDir(), `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || "png"}`)
  writeFileSync(file, buf)
  return file
}

function fileFromDataUrl(url) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(url || "").trim())
  if (!m) return ""
  try { return writeTempImage(Buffer.from(m[2], "base64"), extOfMime(m[1])) } catch { return "" }
}

function fileFromPath(p) {
  const path = String(p || "")
  if (!path || !existsSync(path)) return ""
  try {
    return writeTempImage(readFileSync(path), extOfMime(path))
  } catch { return "" }
}

async function fileFromHttp(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!r.ok) return ""
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 32) return ""
  return writeTempImage(buf, extOfMime(r.headers.get("content-type") || "image/png"))
}

function partImageUrl(part) {
  if (!part || typeof part !== "object") return ""
  if (typeof part.image_url === "string") return part.image_url
  if (part.image_url?.url) return part.image_url.url
  if (typeof part.image === "string") return part.image
  if (part.source?.url) return part.source.url
  return ""
}

async function fileFromPart(part) {
  const type = part?.type
  if (type && type !== "image_url" && type !== "input_image" && type !== "image") return ""
  if (part?.source?.type === "base64" && part.source.data) {
    try { return writeTempImage(Buffer.from(part.source.data, "base64"), extOfMime(part.source.media_type)) } catch { return "" }
  }
  const url = partImageUrl(part)
  if (!url) return ""
  if (url.startsWith("data:")) return fileFromDataUrl(url)
  if (url.startsWith("file:")) {
    let p = decodeURIComponent(url.replace(/^file:\/\//, ""))
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return fileFromPath(p)
  }
  if (/^https?:/i.test(url)) {
    try { return await fileFromHttp(url) } catch { return "" }
  }
  return fileFromPath(url)
}

async function extractImages(messages) {
  const out = []
  const list = Array.isArray(messages) ? messages : [messages]
  for (const msg of list) {
    const parts = Array.isArray(msg?.content) ? msg.content : []
    for (const part of parts) {
      if (out.length >= 4) return out
      const file = await fileFromPart(part)
      if (file) out.push(file)
    }
  }
  return out
}

function textOfContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  const texts = []
  let images = 0
  for (const part of content) {
    if (part?.type === "image_url" || part?.type === "input_image" || part?.type === "image") images += 1
    else if (typeof part?.text === "string" && part.text.trim()) texts.push(part.text)
  }
  if (images) texts.push(`[本轮附了 ${images} 张图片，已随请求送入视觉输入，请直接看图，不要说看不到。]`)
  return texts.join("\n")
}

function dropImages(files) {
  for (const f of files) {
    try {
      unlinkSync(f)
    } catch {}
  }
}

// ── 请求翻译：OpenAI chat completions ↔ Comate autowork ──────────
// magpie 通过 auth.loader.fetch 把 OpenAI 格式请求交进来，这里翻译成 Comate 的 execute，
// 再把结果翻回 OpenAI 格式（含 tool_calls）。工具由 agent（Hermes）执行，插件只做翻译。

// Comate 内置工具名 → OpenAI/Hermes 工具名
const TOOL_TO_OPENAI = {
  Glob: "search_files",
  Grep: "search_files",
  Read: "read_file",
  Bash: "terminal",
  Write: "write_file",
  Edit: "patch",
  WebSearch: "web_search",
  WebFetch: "web_extract",
  run_command: "terminal",
  read_file: "read_file",
  grep_content: "search_files",
  glob_path: "search_files",
  list_dir: "terminal",
  web_search: "web_search",
  web_fetch: "web_extract",
  codebase_search: "search_files",
  read_lints: "read_file",
  Skill: "skill_view",
  skill: "skill_view",
}

// 记住每次工具调用的原始 name/params：Hermes 执行完只回 tool_call_id + content，
// 但 Comate 的 toolUseResults 要求带 name 和 params，得从这里补。
const TOOL_CALLS = new Map()
const TOOL_CALLS_LIMIT = 500

function rememberToolCall(id, name, params) {
  TOOL_CALLS.set(id, { name, params })
  if (TOOL_CALLS.size > TOOL_CALLS_LIMIT) {
    const first = TOOL_CALLS.keys().next().value
    TOOL_CALLS.delete(first)
  }
}

// tool_call_id → conversationId：Hermes 回传工具结果时没有 session key，
// 只能靠 tool_call_id 找回上一轮的会话，否则 Comate 会当成新对话、重复调工具。
const TOOL_CALL_CID = new Map()


const sseChunk = (id, model, delta, finish = null, usage = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`

// Comate 的 TOKEN_USAGE 是 { inputTokens, cachedInputTokens, outputTokens }，转成 OpenAI 的 usage。
// OpenAI 的 prompt_tokens 含缓存命中部分，所以这里加起来，cached 单独放进 details。
function toOpenAiUsage(u) {
  if (!u || typeof u !== "object") return null
  const input = Number(u.inputTokens ?? 0) || 0
  const cached = Number(u.cachedInputTokens ?? 0) || 0
  const completion = Number(u.outputTokens ?? 0) || 0
  const prompt = input + cached
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  }
}

// loader.fetch：magpie 把 OpenAI 格式请求交进来。getAuth 是这个账号的登录态，不自己翻文件。
async function handleChat(input, init, getAuth) {
  const url = String(input ?? "")
  if (url && !/\/chat\/completions(?:\?|$)/.test(url) && !/\/responses(?:\?|$)/.test(url)) {
    return errResponse(400, "comate 插件只翻译 chat completions")
  }
  let body
  try {
    const raw = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body ?? "")
    body = JSON.parse(raw || "{}")
  } catch {
    return errResponse(400, "请求体不是 JSON")
  }
  const model = MODELS.find((m) => m.id === body.model || m.modelId === body.model)
  if (!model) return errResponse(400, `未知模型：${body.model || "(空)"}`)
  const msgs = Array.isArray(body.messages) ? body.messages : []

  const toolResults = msgs
    .filter((m) => m?.role === "tool")
    .map((m) => {
      const known = TOOL_CALLS.get(m.tool_call_id) ?? {}
      return {
        id: m.tool_call_id,
        name: known.name ?? "run_command",
        success: true,
        params: known.params ?? {},
        message: textOfContent(m.content),
      }
    })

  const wantTools = Array.isArray(body.tools) && body.tools.length > 0
  const lastUser = [...msgs].reverse().find((m) => m?.role === "user")
  const question = textOf(lastUser).trim()
  if (!question && !toolResults.length) return errResponse(400, "messages 是空的")

  let auth
  try {
    auth = await authForChat(getAuth)
  } catch (e) {
    return errResponse(401, String(e?.message ?? e), e?.signIn || "expired")
  }
  let license
  try {
    license = await licenseFromAuth(auth)
  } catch (e) {
    const expired = e?.signIn === "expired"
    return errResponse(expired ? 401 : 502, String(e?.message ?? e), expired ? "expired" : "kept")
  }

  const sessionKey = explicitSession(body, init?.headers)
  const toolMsgId = msgs.find((m) => m?.role === "tool")?.tool_call_id
  const cid = (toolMsgId && TOOL_CALL_CID.get(toolMsgId)) || findCid(msgs, sessionKey) || ""
  const query = buildQuery({ question, messages: msgs, cid, toolResults, wantTools, clientTools: body.tools })
  const images = await extractImages(msgs)
  const id = "chatcmpl-" + Date.now().toString(36)
  const signal = combineSignal(300000, init?.signal)

  const finish = async () => {
    const out = await callComate({
      question: query,
      model,
      conversationId: cid,
      images,
      toolResults,
      wantTools,
      license,
      signal,
    })
    // 客户端带了 tools 就绝不能改走 Ask：那段「没有工具」提示会被模型复述成「纯聊天模式」。
    if (!out.text && !out.toolCalls.length) {
      const dropped = out.dropped || []
      throw new Error(dropped.length ? `上游只调用了客户端没有的工具：${[...new Set(dropped)].join(", ")}` : "上游返回了空回复")
    }
    if (out.text && !isNoToolsApology(out.text)) rememberReply(out.text, out.cid, sessionKey)
    for (const tc of out.toolCalls) if (out.cid) TOOL_CALL_CID.set(tc.id, out.cid)
    return out
  }

  if (body.stream) {
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const push = (x) => {
          try { controller.enqueue(enc.encode(x)) } catch {}
        }
        try {
          push(sseChunk(id, model.id, { role: "assistant" }))
          const out = await finish()
          if (out.text) push(sseChunk(id, model.id, { content: out.text }))
          const usage = toOpenAiUsage(out.usage)
          if (out.toolCalls.length) {
            out.toolCalls.forEach((tc, i) => {
              push(sseChunk(id, model.id, {
                tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }],
              }))
            })
            push(sseChunk(id, model.id, {}, "tool_calls", usage))
          } else {
            push(sseChunk(id, model.id, {}, "stop", usage))
          }
          push("data: [DONE]\n\n")
        } catch (e) {
          push(`data: ${JSON.stringify({
            error: {
              message: String(e?.message ?? e),
              type: e?.code === "context_length_exceeded" ? "invalid_request_error" : "upstream_error",
              ...(e?.code ? { code: e.code } : {}),
            },
          })}\n\n`)
          push("data: [DONE]\n\n")
        } finally {
          dropImages(images)
          try { controller.close() } catch {}
        }
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
    })
  }

  try {
    const out = await finish()
    dropImages(images)
    const message = out.toolCalls.length
      ? {
          role: "assistant",
          content: out.text || null,
          tool_calls: out.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        }
      : { role: "assistant", content: out.text }
    return new Response(JSON.stringify({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [{ index: 0, message, finish_reason: out.toolCalls.length ? "tool_calls" : "stop" }],
      usage: toOpenAiUsage(out.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } })
  } catch (e) {
    dropImages(images)
    const expired = e?.signIn === "expired"
    const status = expired ? 401 : e?.status || 502
    return errResponse(status, String(e?.message ?? e), expired ? "expired" : "kept", e?.code)
  }
}

export const ComatePlugin = async (input = {}, options = {}) => {
  const { client } = input
  if (input.directory) pluginDataDir = input.directory
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "comate-auth", level: "info", message } })
    } catch {}
  }

  const cookiesOf = (auth) => {
    if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
      throw signInError("文心快码未登录，请先在 magpie 登录")
    }
    return auth.cookies
  }

  const makeAuth = (cookies, info, source) => ({
    type: "success",
    access: "cookie:" + buildCookieHeader(cookies),
    refresh: "",
    expires: 0,
    source,
    accountId: String(info?.license ?? info?.username ?? PROVIDER_NAME),
    name: String(info?.displayName ?? info?.username ?? ""),
    cookies,
  })

  // 用一份 cookie 直接问 Comate 本人是谁；顺带把死会话挡在登录这一步。
  const verify = async (cookies) => {
    const header = buildCookieHeader(cookies)
    try {
      const info = await getJson("/api/user", header)
      if (info && (info.username || info.license)) return info
    } catch {}
    // /api/user 偶尔被限流，balance 能通就说明这份登录态是活的。
    const bal = await getJson("/api/user/agent/balance", header)
    if (!bal) throw signInError("Cookie 未换到 Comate 账号信息")
    return { username: "", license: "" }
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER_ID] ?? {}
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        ...was,
        models: {
          ...Object.fromEntries(MODELS.map((m) => modelEntry(m))),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER_ID,
      async models() {
        return Object.fromEntries(MODELS.map((m) => modelEntry(m)))
      },
    },

    // 官方教程：sessionID 在同一段对话的各轮之间不变。写进请求头，fetch 里用它续会话。
    "chat.headers": async (input, output) => {
      const pid = input?.model?.providerID || input?.model?.provider?.id || input?.providerID || ""
      if (pid && pid !== PROVIDER_ID) return
      const sid = input?.sessionID || input?.sessionId || ""
      if (!sid) return
      output.headers ??= {}
      output.headers["x-magpie-session"] = String(sid)
    },

    auth: {
      provider: PROVIDER_ID,
      icon: pluginIcon,

      // magpie 把每个 OpenAI 格式请求交给这个 fetch；getAuth() 是当前账号，不自己翻文件。
      loader: (getAuth) => ({
        baseURL: BASE,
        apiKey: "comate",
        headers: { "X-Source": "COMATE", "x-skip-fcnap": "yes" },
        fetch: (input, init) => handleChat(input, init, getAuth),
      }),

      // 登录态是两个 httpOnly cookie，没有 refresh 流。这里只在「复用本机」来源时
      // 跟着 magpie 里 DuMate 的登录态走：那边重登了，这边自动换新的。
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source !== "magpie") return undefined
        const d = readMagpieCookies()
        if (!d) return undefined
        const oldHeader = buildCookieHeader(auth.cookies ?? [])
        const newHeader = buildCookieHeader(d.cookies)
        if (newHeader === oldHeader) return undefined
        try {
          const info = await verify(d.cookies)
          return makeAuth(d.cookies, info, "magpie")
        } catch {
          return undefined
        }
      },

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return { error: cardText(e?.message) || "登录态读取失败", signIn: "expired" }
        }
        if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
          return { error: "没有登录信息，请先在 magpie 登录文心快码", signIn: "kept" }
        }
        const header = buildCookieHeader(auth.cookies)
        const cacheKey = header
        let cached = usageCache.get(cacheKey)
        if (!cached) {
          const disk = readDiskCache()
          if (disk) {
            cached = disk
            usageCache.set(cacheKey, disk)
          }
        }
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data
        try {
          // 只打一个接口：Comate 对同一登录态的短时间连发很敏感，请求越少越稳，
          // 卡片上要的席位/增购/赠送/独立包都在 balance 里。
          const bal = await getJson("/api/user/agent/balance", header)
          if (!bal) throw new Error("Comate 积分接口不可用")

          const seat = packOf(bal.seatPoints)
          const add = packOf(bal.addonPoints)
          const gft = packOf(bal.giftPoints)
          const standalone = packOf(bal.standalonePackPoints)

          const groups = [
            { name: "席位积分", p: seat },
            { name: "增购积分", p: add },
            { name: "赠送积分", p: gft },
            { name: "独立积分包", p: standalone },
          ].filter((g) => g.p.total > 0)

          const availAll = groups.reduce((s, g) => s + g.p.available, 0)

          // 席位积分每月自动补满，下期发放时间在 seatPointsNextUpdate。
          // 日期按接口原串显示，别经 Date 转 UTC。
          const nextSeatRaw = String(bal.seatPointsNextUpdate ?? "")
          const nextSeat = parseCnTime(nextSeatRaw)
          const isMember = seat.total > 0
          const planBits = [isMember ? `会员 · 席位 ${Math.round(seat.total).toLocaleString("en-US")} 分/月` : "Free"]
          if (nextSeat) planBits.push(`下期 ${nextSeatRaw.slice(5, 10)} 补满`)

          const data = {
            plan: planBits.join(" · "),
            balance: `${availAll.toFixed(2)} 积分`,
            windows: groups.map((g) => ({
              name: g.name,
              used: g.p.total > 0 ? (100 * g.p.used) / g.p.total : 0,
              display: `${g.p.used.toFixed(2)} / ${g.p.total.toFixed(2)}`,
              amount: g.p.used,
              limit: g.p.total,
              unit: "points",
            })),
            user: auth.name || auth.accountId || PROVIDER_NAME,
            signIn: "kept",
          }
          usageCache.set(cacheKey, { at: Date.now(), data })
          writeDiskCache(data)
          return data
        } catch (e) {
          const expired = e?.signIn === "expired"
          // 被 Comate 临时拒了（短时间内请求过多会这样）：有旧数据就先给旧的，
          // 卡片不至于空着，下次刷新再拿新的。
          if (cached) return { ...cached.data, error: cardText(e?.message) || "Comate 暂时拒绝请求，显示的是上次数据" }
          return { error: cardText(e?.message) || "Comate 用量查询失败", signIn: expired ? "expired" : "kept" }
        }
      },

      methods: [
        {
          type: "oauth",
          label: "复用 magpie 里已登录的百度账号（零操作）",
          authorize: async () => ({
            url: "",
            instructions:
              "直接复用 magpie 里已登录的百度账号（文心快码与百度搭子共用同一个百度登录态）：只读本机 magpie 的凭据文件，不写任何东西。\n" +
              "如果 magpie 里还没有登录过百度搭子，请改用下面的浏览器登录方式。",
            method: "auto",
            async callback() {
              const d = readMagpieCookies()
              if (!d) {
                return {
                  type: "failed",
                  error: "没找到可复用的百度登录态（magpie 里没有已登录的 DuMate/Comate 账号）。请改用浏览器登录方式。",
                }
              }
              try {
                const info = await verify(d.cookies)
                return makeAuth(d.cookies, info, "magpie")
              } catch (e) {
                return { type: "failed", error: `复用失败：${e?.message ?? e}` }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "百度账号浏览器登录（粘贴 Cookie）",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 点击上方链接，在浏览器登录你的百度账号（登录成功会跳到 comate.baidu.com 个人中心）。\n" +
              "2. 打开 https://comate.baidu.com/zh/user ，按 F12 → Network（网络），刷新页面，点第一个 comate.baidu.com 的请求。\n" +
              "3. 在 Request Headers（请求标头）里找到 Cookie 一行，右键 → Copy value（复制值），粘贴到下方。\n" +
              "（关键登录 Cookie 是 httpOnly，控制台 document.cookie 拿不到，必须从 Network 面板复制）",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim().replace(/^[\"']|[\"']$/g, "")
              if (!raw || !raw.includes("=")) return { type: "failed", error: "请粘贴请求头中 Cookie 行的完整值" }
              const cookies = parseCookieString(raw)
              const missing = missingCookies(cookies, REQUIRED_COOKIES)
              if (missing.length) {
                return {
                  type: "failed",
                  error: `Cookie 缺少关键字段：${missing.join(", ")}。请确认复制的是 comate.baidu.com 请求头里的 Cookie（不是 document.cookie）`,
                }
              }
              try {
                const info = await verify(cookies)
                return makeAuth(cookies, info, "browser")
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}。请重新登录并复制新的 Cookie` }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Cookie 字符串",
          authorize: async () => ({
            url: "",
            instructions: "粘贴完整的 Cookie 字符串（name=value; name2=value2 格式，必须包含 BDUSS，来自 comate.baidu.com 的请求头）：",
            method: "code",
            async callback(input) {
              const cookies = parseCookieString(String(input ?? "").trim())
              if (cookies.length < 2) return { type: "failed", error: "无法解析 Cookie 字符串" }
              const missing = missingCookies(cookies, REQUIRED_COOKIES)
              if (missing.length) return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}` }
              try {
                const info = await verify(cookies)
                return makeAuth(cookies, info, "manual")
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}` }
              }
            },
          }),
        },
      ],
    },
  }
}

export default ComatePlugin

// 单元测试用的纯函数（不联网）。
export const _internal = {
  parseCookieString,
  buildCookieHeader,
  missingCookies,
  packOf,
  parseCnTime,
  toOpenAiUsage,
  estimateTokens,
  modelEntry,
  MODELS,
  handleChat,
  callComate,
}