// @local/dsh-lang-corpus —— 语言语料插件
//
// 两层：
//   采集层：定时从公开渠道抓真人原句（当前：B 站热门视频热评），过滤、去重、
//           限额后写进独立语料库（默认 ~/.dsh/lang-corpus，与日记、人格分开）。
//   检索层：注册 lang_hint 工具。按当前基调从池子里取 2-3 条原句作参照——
//           只给劲儿，不给台词。找不到相近的就明说，不硬套。
//
// 语料只进这个目录，不参与蒸馏、不进 AGENTS.md、不碰 chat-diary。

import { createHash } from 'node:crypto'
import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['tools']

const DEFAULT_DIR = join(homedir(), '.dsh', 'lang-corpus')
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms))

function expandHome(p) {
  if (!p) return DEFAULT_DIR
  if (p === '~') return homedir()
  // 同时认 ~/ 和 ~\ （Windows 上两种写法都有人用）
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2))
  return p
}

// ---------- 语料库文件 ----------

const corpusPath = (dir) => join(dir, 'corpus.jsonl')
const statePath = (dir) => join(dir, 'state.json')

async function readCorpus(dir) {
  const text = await readFile(corpusPath(dir), 'utf8').catch(() => '')
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

async function appendCorpus(dir, entries) {
  if (!entries.length) return
  await mkdir(dir, { recursive: true })
  await appendFile(
    corpusPath(dir),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  )
}

async function readState(dir) {
  try {
    return JSON.parse(await readFile(statePath(dir), 'utf8'))
  } catch {
    return {}
  }
}

async function writeState(dir, state) {
  await mkdir(dir, { recursive: true })
  // 原子写：写到临时文件再 rename。直接覆盖时如果进程崩在中途，
  // state.json 会变成半截 JSON，下次启动 readState 直接丢掉每日计数。
  const target = statePath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmp, target)
}

// ---------- 过滤与去重 ----------

const HAN = /[\u4e00-\u9fff]/g
const hashText = (t) => createHash('sha1').update(t).digest('hex')

function cleanText(s) {
  if (typeof s !== 'string') return ''
  return s
    .replace(/\[[^\[\]]{1,20}\]?/g, ' ') // B 站表情占位符：[doge] [汤圆]，或没闭合的 [BLG
    .replace(/https?:\/\/[^\s，。！!？?]+/gi, ' ') // 链接
    .replace(/\bBV[0-9A-Za-z]{10}\b/g, ' ') // BV 号
    .replace(/\s+/g, ' ')
    .trim()
}

/** 收不收这一句：有人味、不是链接、不是纯 @、不是纯表情。 */
function keepText(t) {
  if (!t || t.length < 4 || t.length > 80) return false
  if (t.includes('http')) return false
  if (t.replace(/@[^\s，,。！!？?]{1,20}/g, '').trim() === '') return false
  const han = (t.match(HAN) || []).length
  return han >= 2
}

// ---------- 场景标签 ----------
// 按"人在什么场合这么说话"给原句打粗标签，检索时基调也走同一张表。
// 宁可漏打，不硬套：命中不了标签的场景就让检索返回空。

const TAG_RULES = {
  损人: /(损|怼|骂|蠢|傻|笨|滚|闭嘴|欠|难绷|逆天|离谱|真行|好家伙|你行你上|阴阳|嘲讽|讽刺|挤兑|挖苦|呛|小丑|拉胯|拉跨|翻车|阴间|答辩|喂史|烂|糊了|服了|乐死你|就这|谁不会|你也配|别叫|叫什么叫)/,
  自嘲: /(自嘲|我(太|真|好|又|就|菜|废|穷|肥|单身|没|不)|本人|菜鸡|废物|废了|躺平|摆烂|社恐|自闭|完蛋|我是|我就|我不配|菜就多练|看不懂|学不会|退坑)/,
  被夸: /(夸|谢谢|好棒|厉害|牛|强啊|牛啊|崇拜|偶像|优秀|大佬|真强|太强|好强|牛哇|绝了|666|有点东西|可以啊|神了|离谱地强|优雅|专业|细|稳)/,
  害羞: /(害羞|脸红|不好意思|捂脸|羞涩|心动|脸红红|哪有|别夸|过分了|顶不住)/,
  调侃: /(哈哈|笑死|笑麻|笑不活|乐死|乐了|乐子|整活|抽象|绷不住|没绷住|破防|吃瓜|玩梗|玩烂梗|调侃|打趣|逗|急了|难绷|乐子人|起猛了|没谁了|什么鬼|离谱|逆天|典|乐)/,
  心疼: /(心疼|抱抱|摸摸|辛苦|加油|难受|哭死|想哭|呜呜|老天|可怜|惨|太难了|破大防|意难平|刀子|心疼你|不容易|撑住|挺住)/,
  冷场: /(尬|冷场|不知道说啥|聊点啥|没人理|好安静|沉默|空气安静|空气凝固|有人吗|在吗|没人说话)/,
  认真: /(说实话|讲道理|认真|正经|客观|事实|分析|理性|说句公道话|其实|本质上|说白了|一句话|结论)/,
  接梗: /(梗|笑点|DNA|复读|经典|同款|懂的都懂|名场面|要素|致敬|老传统|刻在DNA|接住|这个梗|所以|难怪|原来)/,
}

export function tagText(text) {
  const tags = []
  for (const [name, re] of Object.entries(TAG_RULES)) {
    if (re.test(text)) tags.push(name)
  }
  return tags
}

// ---------- 采集（B 站热评） ----------

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      Referer: 'https://www.bilibili.com/',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

// ---------- 按需采集（缺什么补什么） ----------

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const md5 = (s) => createHash('md5').update(s).digest('hex')
const VIRTUAL_CHAR = /[的了着过吗呢吧啊呀嘛就都也还又很最太真才更不没别得地]/

let wbiCache = { key: '', at: 0 }

async function getWbiMixin() {
  if (wbiCache.key && Date.now() - wbiCache.at < 3600_000) return wbiCache.key
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav')
  const img = nav?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0]
  const sub = nav?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0]
  if (!img || !sub) throw new Error('拿不到 wbi key')
  const raw = img + sub
  const mixin = MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32)
  wbiCache = { key: mixin, at: Date.now() }
  return mixin
}

/** 从基调里抓两三个关键词去搜。 */
function toneKeywords(tone) {
  const clean = String(tone).replace(/[^\u4e00-\u9fff]/g, '')
  const cands = []
  for (let i = 0; i < clean.length - 1; i++) cands.push(clean.slice(i, i + 2))
  const out = []
  for (const c of cands) if (!VIRTUAL_CHAR.test(c) && !out.includes(c)) out.push(c)
  if (!out.length) out.push(...cands.slice(0, 2))
  return out.slice(0, 3)
}

async function searchVideos(keyword) {
  const mixin = await getWbiMixin()
  const params = {
    search_type: 'video',
    keyword,
    page: '1',
    wts: String(Math.floor(Date.now() / 1000)),
  }
  const q = Object.keys(params)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!()*]/g, ''))}`,
    )
    .join('&')
  const data = await fetchJson(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${q}&w_rid=${md5(q + mixin)}`,
  )
  return (data?.data?.result || [])
    .filter((x) => x && typeof x === 'object' && (x.type === 'video' || x.aid))
    .slice(0, 8)
}

async function fetchReplies(aid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchJson(
        `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=20&pn=1`,
      )
      return r?.data?.replies || []
    } catch {
      /* 失败 1 秒后重试一次 */
      await SLEEP(1000)
    }
  }
  return []
}

async function collectBilibili(cap) {
  const items = []
  // 热门视频接口单页最多 20 个视频，热评接口对游客固定只给 3 条热门评论。
  // 所以靠翻视频页攒量：2 页 = 40 个视频 × 3 条 = 120 条候选。
  const videos = []
  for (const pn of [1, 2]) {
    const pop = await fetchJson(
      `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`,
    )
    videos.push(...(pop?.data?.list || []))
    await SLEEP(800)
  }
  for (const v of videos) {
    if (items.length >= cap) break
    for (const rep of await fetchReplies(v.aid)) {
      const msg = cleanText(rep?.content?.message)
      if (!keepText(msg)) continue
      items.push({
        text: msg,
        source: 'bilibili',
        title: typeof v.title === 'string' ? v.title.slice(0, 40) : undefined,
        tags: tagText(msg),
        at: new Date().toISOString(),
      })
      if (items.length >= cap) break
    }
    await SLEEP(1200) // 礼貌间隔
  }
  return items
}

// 按需采集同一时间只跑一个，避免并行请求触发风控。
let onDemandBusy = false

// state.json 的读-改-写必须串行。
// 关键：**网络请求不能占着这把锁** —— 一次采集要几十秒，占着锁会把
// 记需求（lang_hint 调用）和另一路采集全堵住。所以流程拆成：
//   1) 短锁：读状态、算还能收多少
//   2) 无锁：抓网络
//   3) 短锁：去重、写入、更新状态
let stateChain = Promise.resolve()
function withStateLock(fn) {
  const run = stateChain.then(fn, fn)
  stateChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 只负责抓，不碰 state / 语料文件。 */
async function fetchForTone(tone, cap) {
  if (onDemandBusy) return []
  onDemandBusy = true
  try {
    const items = []
    const seenAids = new Set()
    for (const kw of toneKeywords(tone)) {
      if (items.length >= cap) break
      const videos = await searchVideos(kw).catch(() => [])
      for (const v of videos) {
        if (items.length >= cap) break
        if (!v.aid || seenAids.has(v.aid)) continue
        seenAids.add(v.aid)
        for (const rep of await fetchReplies(v.aid)) {
          const msg = cleanText(rep?.content?.message)
          if (!keepText(msg)) continue
          items.push({
            text: msg,
            source: 'bilibili-search',
            title: typeof v.title === 'string' ? v.title.slice(0, 40) : undefined,
            tags: tagText(msg),
            at: new Date().toISOString(),
          })
          if (items.length >= cap) break
        }
        await SLEEP(1200)
      }
    }
    return items
  } finally {
    onDemandBusy = false
  }
}

/** 只负责写：调用方必须已经持有 state 锁。 */
async function commitForTone(dir, cfg, state, tone, items, cap) {
  const day = localDay()
  if (!state.day || state.day.date !== day) state.day = { date: day, count: 0 }
  // 按需采集允许在当日配额之外多收一点（demandBonus），
  // 否则定时采集把 80 条刷满后，lang_hint 一整天都拿不到东西。
  const remaining = Math.max(0, cfg.dailyCap + (cfg.demandBonus || 0) - state.day.count)
  if (remaining <= 0) {
    state.lastDemand = { tone, at: new Date().toISOString(), added: 0 }
    await writeState(dir, state)
    return 0
  }
  const seen = new Set((await readCorpus(dir)).map((e) => e.hash || hashText(e.text)))
  const fresh = []
  for (const item of items) {
    const h = hashText(item.text)
    if (seen.has(h)) continue
    seen.add(h)
    fresh.push({ ...item, hash: h })
    if (fresh.length >= Math.min(cap, remaining)) break
  }
  if (fresh.length) {
    await appendCorpus(dir, fresh)
    state.day.count += fresh.length
    state.total = (state.total || 0) + fresh.length
  }
  state.lastDemand = { tone, at: new Date().toISOString(), added: fresh.length }
  await writeState(dir, state)
  return fresh.length
}

async function queueDemand(dir, tone) {
  return withStateLock(async () => {
  const state = await readState(dir)
  const now = Date.now()
  state.demandCooldown = state.demandCooldown || {}
  if (
    state.demandCooldown[tone] &&
    now - state.demandCooldown[tone] < 6 * 3600_000
  ) {
    return false
  }
  // 冷却表会随「见过的基调」无限增长（state.json 越来越大），只留最近 7 天、最多 200 个
  try {
    const cooldown = state.demandCooldown
    for (const k of Object.keys(cooldown)) {
      if (now - cooldown[k] > 7 * 86400_000) delete cooldown[k]
    }
    const keys = Object.keys(cooldown)
    if (keys.length > 200) {
      keys.sort((a, b) => cooldown[a] - cooldown[b])
      for (const k of keys.slice(0, keys.length - 200)) delete cooldown[k]
    }
  } catch { /* 冷却表异常不影响主流程 */ }
  state.demandCooldown[tone] = now
  state.demands = (state.demands || [])
    .filter((d) => d.tone !== tone)
    .slice(-19)
  state.demands.push({ tone, at: new Date(now).toISOString(), done: false })
  await writeState(dir, state)
  return true
  })
}

function localDay() {
  return new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD，本地日期
}

/** 只抓网络，不碰状态。want 是本次最多想要多少条。 */
async function fetchRaw(cfg, want) {
  const raw = []
  if (cfg.sources.includes('bilibili')) raw.push(...(await collectBilibili(want)))
  return raw
}

/** 只写状态，调用方必须持有 state 锁。 */
async function commitRaw(dir, cfg, state, raw) {
  const day = localDay()
  if (!state.day || state.day.date !== day) state.day = { date: day, count: 0 }
  const cap = Math.max(0, cfg.dailyCap - state.day.count)
  if (cap <= 0) {
    state.lastSkipped = new Date().toISOString()
    await writeState(dir, state)
    return { added: 0, skipped: true }
  }

  const seen = new Set((await readCorpus(dir)).map((e) => e.hash || hashText(e.text)))

  const fresh = []
  for (const item of raw) {
    const h = hashText(item.text)
    if (seen.has(h)) continue
    seen.add(h)
    fresh.push({ ...item, hash: h })
    if (fresh.length >= cap) break
  }

  await appendCorpus(dir, fresh)
  state.day.count += fresh.length
  state.lastRun = new Date().toISOString()
  state.total = (state.total || 0) + fresh.length
  await writeState(dir, state)
  return { added: fresh.length, skipped: false }
}
async function pruneCorpus(dir, keepDays) {
  if (!keepDays || keepDays <= 0) return 0
  const cutoff = Date.now() - keepDays * 86400_000
  const all = await readCorpus(dir)
  const kept = all.filter((e) => {
    const t = Date.parse(e.at || '')
    return Number.isNaN(t) || t >= cutoff
  })
  if (kept.length === all.length) return 0
  const target = corpusPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  await rename(tmp, target)
  return all.length - kept.length
}

// ---------- 检索（按基调取参照） ----------

function bigrams(s) {
  const clean = String(s).replace(/[^\p{L}\p{N}]/gu, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  if (clean.length === 1) set.add(clean)
  return set
}

export async function searchCorpus(dir, tone, count) {
  const corpus = await readCorpus(dir)
  if (!corpus.length) return { examples: [], total: 0, weak: false }
  const toneTags = new Set(tagText(tone))
  const q = bigrams(tone)
  if (!toneTags.size && !q.size) return { examples: [], total: corpus.length, weak: false }

  // 每句算两个分：标签命中（场景），字面重合（bigram）。
  // 标签命中是强信号；没有标签命中时，字面要够近才收。
  const scored = []
  for (const e of corpus) {
    const eTags = Array.isArray(e.tags) && e.tags.length ? e.tags : tagText(e.text)
    let tagScore = 0
    for (const t of eTags) if (toneTags.has(t)) tagScore++
    let bigramScore = 0
    if (q.size) {
      const g = bigrams(e.text)
      for (const x of q) if (g.has(x)) bigramScore++
    }
    scored.push({ e, tagScore, bigramScore, score: tagScore * 10 + bigramScore })
  }

  // 优先：标签命中的句子；其次：字面重合 >= 2 的句子；最后：字面重合 1 的弱候选。
  let pool = scored.filter((s) => s.tagScore > 0)
  let weak = false
  if (!pool.length) {
    pool = scored.filter((s) => s.tagScore === 0 && s.bigramScore >= 2)
    // 这一档没有场景命中，只是字面像；算弱匹配，别让调用方以为很准
    weak = pool.length > 0
  }
  if (!pool.length) {
    pool = scored.filter((s) => s.bigramScore >= 1)
    weak = pool.length > 0
  }
  // 确定性排序：同分按句子哈希，可复现，不用随机数。
  pool.sort(
    (a, b) =>
      b.score - a.score ||
      hashText(a.e.text).localeCompare(hashText(b.e.text)),
  )
  const picked = pool.slice(0, count)
  return {
    examples: picked.map((s) => ({ text: s.e.text, source: s.e.source })),
    total: corpus.length,
    weak,
  }
}

// ---------- 插件主体 ----------

export function apply(ctx, rawConfig = {}) {
  const cfg = {
    ...rawConfig,
    dir: expandHome(rawConfig?.dir),
    intervalHours:
      Number(rawConfig?.intervalHours) > 0 ? Number(rawConfig.intervalHours) : 24,
    dailyCap: Number(rawConfig?.dailyCap) > 0 ? Number(rawConfig.dailyCap) : 80,
    sources:
      Array.isArray(rawConfig?.sources) && rawConfig.sources.length
        ? rawConfig.sources
        : ['bilibili'],
    keepDays: Number(rawConfig?.keepDays) > 0 ? Number(rawConfig.keepDays) : 120,
    // 按需采集的溢出额度：定时配额用完后，仍允许为 lang_hint 再收这么多条
    demandBonus:
      Number.isFinite(Number(rawConfig?.demandBonus)) && Number(rawConfig.demandBonus) >= 0
        ? Number(rawConfig.demandBonus)
        : 20,
  }
  const dir = cfg.dir

  // 检索层：lang_hint 工具
  ctx.effect(() =>
    ctx.tools.register({
      name: 'lang_hint',
      description:
        '按当前基调，从真人语料池取 2-3 条原句作参照。tone 写你此刻对这条消息的真实反应或想使的劲儿，比如「想损他一句」「被夸得不好意思」「冷场了想找话」。看的是劲儿，不是句子：看完把句子忘掉，用自己的话说。找不到相近的参照会明说，别硬套。',
      parameters: {
        type: 'object',
        properties: {
          tone: {
            type: 'string',
            description: '此刻的基调 / 场景，一句话。',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            default: 3,
            description: '取几条参照，默认 3。',
          },
        },
        required: ['tone'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            examples: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  source: { type: 'string' },
                },
                required: ['text'],
              },
            },
            note: { type: 'string' },
          },
          required: ['examples'],
        },
        render(_args, value) {
          const lines = (value.examples || []).map(
            (ex, i) => `${i + 1}. ${ex.text}`,
          )
          // note 必须跟着例子一起给模型：弱匹配时那句「只是字面接近，别硬套」
          // 原来只在「一条都没有」时才输出，等于把预警吞了。
          const text = lines.length
            ? value.note
              ? `${lines.join('\n')}\n\n${value.note}`
              : lines.join('\n')
            : value.note || '没有找到相近的参照。'
          return [{ type: 'text', text }]
        },
      },
      async execute(args) {
        const tone = String(args?.tone ?? '').trim()
        if (!tone) {
          return { examples: [], note: 'tone 是空的，没翻。想要参照，先说清楚是什么基调。' }
        }
        const count = Math.min(5, Math.max(1, Number(args?.count) || 3))
        let r
        try {
          r = await searchCorpus(dir, tone, count)
        } catch (e) {
          // 语料文件被占用/损坏时别把工具调用整个搞崩，给一句实话
          return {
            examples: [],
            note: `语料池读不出来（${String(e?.message ?? e).slice(0, 80)}），这次没有参照，别硬套。`,
          }
        }
        // 空手或只有弱匹配：记下这个基调，后台去补采，别让这次回答干等。
        let queued = false
        if (!r.examples.length || r.weak) {
          queued = await queueDemand(dir, tone).catch(() => false)
          if (queued) {
            void demandCollect(dir, cfg, tone).catch((e) =>
              console.warn('[lang-corpus] 按需采集失败:', e?.message ?? e),
            )
          }
        }
        if (!r.examples.length) {
          return {
            examples: [],
            note: queued
              ? '语料池里没有和这个基调相近的原句，别硬套。已记下，后台去补采。'
              : '语料池里没有和这个基调相近的原句，别硬套。这个基调 6 小时内刚补过，还没攒到新的。',
          }
        }
        return {
          examples: r.examples,
          note: r.weak
            ? `这几条只是字面接近，未必对味儿，别硬套。池子共 ${r.total} 条。`
            : `参照用，别抄句子。池子共 ${r.total} 条。`,
        }
      },
    }),
  )

  // 采集层：定时抓料
  // 按需采集：记一笔需求 → 后台抓对应关键词的评论 → 入池。不阻塞回答。
  // 网络在锁外、状态在锁内：抓取几十秒也不挡别的调用。
  const demandCollect = async (dir, cfg, tone) => {
    const plan = await withStateLock(async () => {
      const state = await readState(dir)
      const day = localDay()
      const used = state.day && state.day.date === day ? state.day.count : 0
      return { remaining: Math.max(0, cfg.dailyCap + (cfg.demandBonus || 0) - used) }
    })
    let added = 0
    if (plan.remaining > 0) {
      const items = await fetchForTone(tone, 24).catch((e) => {
        console.warn('[lang-corpus] 按需抓取失败:', e?.message ?? e)
        return []
      })
      added = await withStateLock(async () => {
        const state = await readState(dir)
        return commitForTone(dir, cfg, state, tone, items, 24)
      })
    }
    await withStateLock(async () => {
      const s2 = await readState(dir)
      if (Array.isArray(s2.demands)) {
        const d = s2.demands.find((x) => x.tone === tone)
        if (d) d.done = true
        await writeState(dir, s2)
      }
    })
    if (added > 0) console.log(`[lang-corpus] 按需补采「${tone}」+${added} 条`)
    return added
  }

  const maybeCollect = async () => {
    // 1) 短锁：判断该不该跑、还能收多少
    const plan = await withStateLock(async () => {
      const state = await readState(dir)
      const last = state.lastRun ? Date.parse(state.lastRun) : 0
      if (Date.now() - last < cfg.intervalHours * 3600_000 * 0.9) return null
      const day = localDay()
      const used = state.day && state.day.date === day ? state.day.count : 0
      return { remaining: Math.max(0, cfg.dailyCap - used) }
    })
    if (plan === null) return

    // 2) 无锁：抓网络
    const raw = plan.remaining > 0 ? await fetchRaw(cfg, plan.remaining + 20) : []

    // 3) 短锁：写入 + 清理过期
    const r = await withStateLock(async () => {
      const state = await readState(dir)
      const res = await commitRaw(dir, cfg, state, raw)
      const pruned = await pruneCorpus(dir, cfg.keepDays)
      if (pruned > 0) {
        const st = await readState(dir)
        st.total = Math.max(0, (st.total || 0) - pruned)
        await writeState(dir, st)
      }
      return { ...res, pruned }
    })
    if (r.added > 0) console.log(`[lang-corpus] +${r.added} 条入池`)
    if (r.pruned > 0) console.log(`[lang-corpus] -${r.pruned} 条过期`)
  }

  ctx.effect(() => {
    let stopped = false
    let retryTimer = null
    const run = () => {
      if (stopped) return
      maybeCollect().catch(async (e) => {
        const msg = e?.message ?? String(e)
        console.warn('[lang-corpus] 采集失败，5 分钟后重试:', msg)
        // 留痕：state.lastError 记录失败时间和原因，排查时不用翻控制台
        await readState(dir)
          .then(async (st) => {
            st.lastError = { at: new Date().toISOString(), message: String(msg).slice(0, 300) }
            await writeState(dir, st)
          })
          .catch(() => {})
        if (!stopped) retryTimer = setTimeout(run, 5 * 60_000)
      })
      // 上次没补完的需求，顺手补一个
      readState(dir)
        .then((s) => {
          const pending = (s.demands || []).find((d) => !d.done)
          if (pending) void demandCollect(dir, cfg, pending.tone).catch(() => {})
        })
        .catch(() => {})
    }
    const timer = setInterval(run, cfg.intervalHours * 3600_000)
    const boot = setTimeout(run, 10_000)
    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(boot)
      if (retryTimer) clearTimeout(retryTimer)
    }
  })
}
