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
// 认证只需要把 license 放进 login-name 头，没有签名 / 设备绑定，所以不需要起进程。
// 插件自己起一个 127.0.0.1 上的 OpenAI 兼容口，把这些接口翻译成 /v1/chat/completions。
// 服务随插件生命周期起落，删插件即消失。
//
// 本插件只读 magpie 的凭据：不写 magpie 的配置，只写一份用量缓存（comate-usage-cache.json）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
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

function dataDir() {
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

// ───────────────────────────── 模型：走官方 zulu CLI，插件内起一个 OpenAI 兼容口 ─────────────────────────────
//
// Comate 没有公开的 OpenAI 兼容 API，但官方 CLI（@comate/zulu）能用 license 登录并跑 Ask 模式。
// 所以插件自己在 127.0.0.1 上起一个小服务，把 /v1/chat/completions 翻译成 `zulu run --mode Ask`，
// magpie 看到的就是一个普通的 OpenAI 兼容 provider。服务随插件生命周期起落，删插件即消失。
//
// 关键坑：zulu 的 API_MAP 里没有 SAAS 平台，默认掉到内网域名 comate.baidu-int.com；
// 必须显式 HTTP_HOST=https://comate.baidu.com，否则报 ENOTFOUND / TLS 断开。


// modelId 是 Comate 服务端认的完整 key（<type>_<hash>），从 `zulu list-model` 取一次，
// 会随服务端版本变；对不上时用 modelType 前缀兜底，再不行就报错让用户重跑 list-model。
const MODELS = [
  { id: "deepseek-v4-flash", modelId: "deepseek-v4-flash_a8668ea86c3d40e7ad1f8ee45715d447", label: "Deepseek V4 Flash", vision: false },
  { id: "deepseek-v4-pro", modelId: "deepseek-v4-pro_4ba5277b630243be9eeb19fe48f853fa", label: "Deepseek V4 Pro", vision: false },
  { id: "deepseek-v4.1-flash", modelId: "deepseek-v4.1-flash_4827e158760447029e6594bb2b1ab066", label: "Deepseek V4.1 Flash", vision: true, effort: ["low", "high", "max"] },
  { id: "ernie-5.5-flash-preview", modelId: "ernie-5.5-flash-preview_996d9d76bb7c45ecbff286216aaeeab2", label: "ERNIE 5.5 Flash Preview", vision: true },
  { id: "glm-4.7-fc", modelId: "glm-4.7-fc_0b87452a03394418b5c8d5468deff6c7", label: "GLM-4.7", vision: false },
  { id: "glm-5-turbo-fc", modelId: "glm-5-turbo-fc_6748c832242b4bcb8f715c7c7902d1ad", label: "GLM-5-Turbo", vision: false },
  { id: "glm-5.1", modelId: "glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9", label: "GLM-5.1", vision: false },
  { id: "glm-5.2", modelId: "glm-5.2_50c584482e9d47edbbe47938a88b56b1", label: "GLM-5.2", vision: false },
  { id: "glm-5.3", modelId: "glm-5.3_37c550fc6d5b4fb2825abc2c1c88a6b3", label: "GLM-5.3", vision: false, effort: ["low", "high", "max"] },
  { id: "glm-5.3-flash", modelId: "glm-5.3-flash_805131a9381a4940ba0f2d90cad0e7eb", label: "GLM-5.3-Flash", vision: true },
  { id: "glm-5v-turbo", modelId: "glm-5v-turbo_ea9e4f222f0a40b281953ebcb6981dda", label: "GLM-5v-Turbo", vision: true },
  { id: "kimi-k2.6-oneapi", modelId: "kimi-k2.6-oneapi_123e4567e89b12d3a456426614174000", label: "Kimi-K2.6", vision: true },
  { id: "minimax-m2.5-fc", modelId: "minimax-m2.5-fc_c99ea14f526548a8bc28717d4e854123", label: "MiniMax M2.5", vision: false },
  { id: "minimax-m3", modelId: "minimax-m3_a8f465fbedb942efadace88370ad7ff1", label: "MiniMax M3", vision: true },
  { id: "minimax-m2.7-fc", modelId: "minimax-m2.7-fc_047f123f661c414bb253c05b605c391e", label: "MiniMax-M2.7", vision: false },
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
      limit: { context: 128000, output: 8192 },
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

async function apiPost(license, path, body, { timeoutMs = 60000 } = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { ...API_HEADERS(license), "X-Trace-Id": randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

// 一轮对话：建会话（或复用）→ 建任务 → execute；边收 SSE 边把增量交给 onDelta。
async function callComate({ question, history, model, conversationId, images = [], toolResults = [], wantTools = false, onDelta, timeoutMs = 300000 }) {
  const auth = readMagpieCookies()
  if (!auth?.cookies?.length) throw new Error("没有百度 cookie：先 `magpie plugin login comate` 登录一次")
  const license = await getLicense(buildCookieHeader(auth.cookies))
  const base = apiBase(license)

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
    const conv = await apiPost(license, "/api/aidevops/autocomate/rest/autowork/v2/conversation", { agentId: wantTools ? 1 : 8, ...base })
    cid = conv?.data?.id
    if (!cid) throw new Error(`建会话失败：${JSON.stringify(conv).slice(0, 200)}`)
  }

  const query = history ? `${history}\n\n用户：${question}` : question

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
      })
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
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300)
      const e = new Error(`execute ${r.status} ${detail}`)
      e.compression = /NeedCompressionException/.test(detail)
      throw e
    }

    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let text = ""
    let err = ""
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
        if (c.type === "EXCEPTION") err = c.detail?.exceptionMsg ?? c.text ?? "unknown"
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
    // 只把 Hermes 认识的工具交出去：Comate 的 Skill / Glob 这类没有对应实现，
    // 原样透传会让客户端报 "Model generated invalid tool call: Skill"。
    const toolCalls = [...pending.entries()]
      .map(([id, v]) => {
        rememberToolCall(id, v.name, v.args) // Comate 原始 name/params，回传结果时要原样还回去
        const mapped = TOOL_TO_OPENAI[v.name]
        return mapped ? { id, name: mapped, arguments: v.args } : null
      })
      .filter(Boolean)
    if (err && !text && !toolCalls.length) {
      const e = new Error(err)
      e.compression = /NeedCompressionException/.test(err)
      throw e
    }
    return { text, toolCalls, usage }
  }

  // 输入特别大时，先直接带 needCompression 发一次：服务端本来就要压，等它回
  // NeedCompressionException 再重试等于白跑一轮（实测 802K/953K 的请求因此多花 15~20 秒）。
  // 估算只用来决定「先问压缩」，估低了还有下面的异常重试兜底。
  const estimateTokens = (s) => {
    const text = String(s ?? "")
    let cjk = 0
    for (const ch of text) {
      const c = ch.codePointAt(0)
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f)) cjk++
    }
    return Math.round(cjk * 0.63 + (text.length - cjk) * 0.3)
  }
  const compressUpfront = estimateTokens(query) >= 700000

  let out
  try {
    out = await executeOnce(compressUpfront)
  } catch (e) {
    if (!e?.compression) throw e
    if (compressUpfront) {
      throw new Error(
        "Comate 上下文已超出可压缩范围（NeedCompressionException）：这次输入太大，压缩后仍装不下，请缩短单条输入或另开会话",
      )
    }
    // 官方 zulu 客户端的做法：带 needCompression=true 重发一次，让服务端先压缩历史再执行。
    try {
      out = await executeOnce(true)
    } catch (e2) {
      if (e2?.compression) {
        throw new Error(
          "Comate 上下文已超出可压缩范围（NeedCompressionException）：这次输入太大，压缩后仍装不下，请缩短单条输入或另开会话",
        )
      }
      throw e2
    }
  }
  return { text: out.text, cid, toolCalls: out.toolCalls, usage: out.usage }
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

function findCid(messages, sessionKey) {
  // ① 客户端如果给了明确的会话标识（header / prompt_cache_key），优先用它
  if (sessionKey) {
    const cid = REPLY_INDEX.get("k:" + sessionKey)
    if (cid) return cid
  }
  // ② 兜底：上一轮我返回的 assistant 文本，客户端这一轮必然带回来
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue
    const cid = REPLY_INDEX.get(quickHash(textOf(messages[i])))
    if (cid) return cid
  }
  return ""
}

// 只认「明确是会话」的标识。不用 OpenAI 的 `user` 字段——那是用户身份，
// 拿它当会话 key 会把同一用户的不同对话串成一条。
function explicitSession(body, headers) {
  const cands = [
    body?.prompt_cache_key,
    headers?.["x-session-id"],
    headers?.["x-conversation-id"],
    headers?.["x-thread-id"],
  ]
  for (const v of cands) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

function rememberReply(text, cid, sessionKey) {
  if (!text || !cid) return
  REPLY_INDEX.set(quickHash(text), cid)
  if (sessionKey) REPLY_INDEX.set("k:" + sessionKey, cid)
  while (REPLY_INDEX.size > REPLY_LIMIT) REPLY_INDEX.delete(REPLY_INDEX.keys().next().value)
}

// 图片：OpenAI 传的是 data URL，zulu 要文件路径，落一份临时文件，用完就删。
function imageDir() {
  const d = join(selfDir(), ".tmp")
  try {
    mkdirSync(d, { recursive: true })
  } catch {}
  return d
}

function extractImages(message) {
  const out = []
  if (!Array.isArray(message?.content)) return out
  for (const part of message.content) {
    if (part?.type !== "image_url") continue
    const url = part?.image_url?.url ?? ""
    const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(url)
    if (!m) continue
    const ext = m[1] === "jpeg" ? "jpg" : m[1].replace(/[^a-z0-9]/gi, "") || "png"
    const file = join(imageDir(), `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    try {
      writeFileSync(file, Buffer.from(m[2], "base64"))
      out.push(file)
    } catch {}
  }
  return out
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
// 之前这个事件被直接丢掉，网关那边看到的 prompt/completion 就永远是 0。
// OpenAI 的 prompt_tokens 含缓存命中部分，所以这里加起来，cached 单独放进 details。
const toOpenAiUsage = (u) => {
  const input = Number(u?.inputTokens ?? 0)
  const cached = Number(u?.cachedInputTokens ?? 0)
  const completion = Number(u?.outputTokens ?? 0)
  const prompt = input + cached
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  }
}

// loader.fetch：magpie 把 OpenAI 格式请求交进来
async function handleChat(init) {
  const raw = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body ?? "")
  const body = JSON.parse(raw || "{}")
  const model = MODELS.find((m) => m.id === body.model || m.modelId === body.model) ?? MODELS[0]
  const msgs = Array.isArray(body.messages) ? body.messages : []

  // Hermes 执行完工具后回传的 role:"tool" 消息 → Comate 的 toolUseResults
  const toolResults = msgs
    .filter((m) => m?.role === "tool")
    .map((m) => {
      const known = TOOL_CALLS.get(m.tool_call_id) ?? {}
      return {
        id: m.tool_call_id,
        name: known.name ?? "run_command",
        success: true,
        params: known.params ?? {},
        message: String(m.content ?? ""),
      }
    })

  const wantTools = Array.isArray(body.tools) && body.tools.length > 0
  const lastUser = [...msgs].reverse().find((m) => m?.role === "user")
  const question = textOf(lastUser).trim()
  if (!question && !toolResults.length) {
    return new Response(JSON.stringify({ error: { message: "messages 是空的", type: "invalid_request_error" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const sessionKey = String(body.prompt_cache_key ?? init?.headers?.["x-session-id"] ?? "")
  const toolMsgId = msgs.find((m) => m?.role === "tool")?.tool_call_id
  const cid = (toolMsgId && TOOL_CALL_CID.get(toolMsgId)) || findCid(msgs, sessionKey) || ""
  const images = extractImages(lastUser)
  const id = "chatcmpl-" + Date.now().toString(36)

  if (body.stream) {
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const push = (x) => {
          try {
            controller.enqueue(enc.encode(x))
          } catch {}
        }
        try {
          push(sseChunk(id, model.id, { role: "assistant" }))
          const out = await callComate({
            question,
            model,
            conversationId: cid,
            images,
            toolResults,
            wantTools,
            onDelta: (d) => push(sseChunk(id, model.id, { content: d })),
          })
          rememberReply(out.text, out.cid, sessionKey)
          for (const tc of out.toolCalls) if (out.cid) TOOL_CALL_CID.set(tc.id, out.cid)
          if (out.toolCalls.length) {
            out.toolCalls.forEach((tc, i) => {
              push(
                sseChunk(id, model.id, {
                  tool_calls: [
                    { index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } },
                  ],
                }),
              )
            })
            push(sseChunk(id, model.id, {}, "tool_calls", toOpenAiUsage(out.usage)))
          } else {
            push(sseChunk(id, model.id, {}, "stop", toOpenAiUsage(out.usage)))
          }
          push("data: [DONE]\n\n")
        } catch (e) {
          push(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e), type: "upstream_error" } })}\n\n`)
          push("data: [DONE]\n\n")
        } finally {
          dropImages(images)
          try {
            controller.close()
          } catch {}
        }
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
    })
  }

  try {
    const out = await callComate({ question, model, conversationId: cid, images, toolResults, wantTools })
    dropImages(images)
    rememberReply(out.text, out.cid, sessionKey)
    for (const tc of out.toolCalls) if (out.cid) TOOL_CALL_CID.set(tc.id, out.cid)
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
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [{ index: 0, message, finish_reason: out.toolCalls.length ? "tool_calls" : "stop" }],
        usage: toOpenAiUsage(out.usage),
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    )
  } catch (e) {
    dropImages(images)
    return new Response(JSON.stringify({ error: { message: String(e?.message ?? e), type: "upstream_error" } }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  }
}

export const ComatePlugin = async ({ client, magpie } = {}, options = {}) => {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "comate-auth", level: "info", message } })
    } catch {}
  }
  // 插件自己的 OpenAI 兼容口（起不来就只当额度卡片，不影响登录）

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

    auth: {
      provider: PROVIDER_ID,
      icon: pluginIcon,

      // magpie 把每个 OpenAI 格式请求交给这个 fetch；插件只做翻译，工具由 agent 自己跑。
      loader: () => ({
        baseURL: BASE,
        apiKey: "comate",
        headers: { "X-Source": "COMATE", "x-skip-fcnap": "yes" },
        fetch: (input, init) => handleChat(init),
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
}