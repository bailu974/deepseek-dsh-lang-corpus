# dsh-lang-corpus

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**语言语料**插件。

两层，互不干扰：

- **采集层**：定时从 B 站热门视频的热评里抓真人原句，过滤、去重、限额后写进独立语料库
- **检索层**：注册工具 `lang_hint`，按「此刻的基调」取 2~3 条原句作参照

> 语料只进 `~/.dsh/lang-corpus/`，**不参与人格蒸馏、不进 `AGENTS.md`、不碰日记**。
> 它给的是「劲儿」，不是台词本。

---

## 它怎么工作

```
采集层（默认每 24 小时）
  → 拉热门视频的热评（游客接口每个视频固定 3 条）
  → 过滤：4~80 字、至少两个汉字、去链接 / 去纯 @ / 去纯表情
  → 按文本 SHA-1 精确去重
  → 每天最多入池 dailyCap 条，顺手打场景标签

检索层（工具 lang_hint）
  → 输入 tone（此刻的劲儿，如「想损他一句」）+ count（默认 3）
  → 先按场景标签命中，再按字面重合兜底
  → 找不到相近的就明说「别硬套」，不随机凑数
```

数据文件：

```
~/.dsh/lang-corpus/
├── corpus.jsonl   # 一条一行：text / source / tags / at / hash
└── state.json     # 每日计数、上次运行、冷却表、失败记录
```

---

## 安装

```bash
# 本地目录（推荐）
git clone https://github.com/bailu974/deepseek-dsh-lang-corpus.git
dsh plugin --profile desktop add link:/path/to/deepseek-dsh-lang-corpus

# 或者直接（需要本机有 git）
dsh plugin --profile desktop add https://github.com/bailu974/deepseek-dsh-lang-corpus
```

装好后 profile 的 `dsh.profile.bundles` 会多一项 `lang-corpus`。

> ⚠️ 如果你在 **QQ 桥接**这类「工具白名单」环境里用它，要把 `lang_hint` 加进执行期白名单
> （`qq-tool-restrict.mjs` 的 `SAFE_EXACT`），否则会出现「看得见、一调就被拒」。

---

## 配置

```yaml
dir: '~/.dsh/lang-corpus'   # 语料目录，支持 ~ 和 ~\
intervalHours: 24           # 定时采集间隔（小时）
dailyCap: 80                # 每天定时入池上限
demandBonus: 20             # 按需采集的溢出额度（见下）
keepDays: 120               # 过期清理（天）
sources: [bilibili]         # 采集来源
```

**`demandBonus` 是干什么的**

定时采集和按需采集共用一个每日计数。如果只按 `dailyCap` 算，定时把那 80 条刷满之后，
`lang_hint` 一整天都拿不到新增——工具就成了「早上能用、晚上失灵」。
`demandBonus` 给按需采集留一份溢出额度：超出 `dailyCap` 后仍可再收这么多条。

---

## 工具：`lang_hint`

```
lang_hint(tone, count=3)
```

- `tone`：写你此刻对这条消息的真实反应或想使的劲儿，比如「想损他一句」「被夸得不好意思」「冷场了想找话」
- 返回 2~3 条原句 + 一句提示
- **弱匹配会明说**：「这几条只是字面接近，未必对味儿，别硬套」
- 一条都没有就返回空 + 「别硬套」，同时记下这个基调，后台去补采（6 小时冷却）

看的是劲儿，不是句子：看完把句子忘掉，用自己的话说。

---

## 本仓库相对上游修了什么

上游版本在真实使用中会「看起来在跑、实际已经坏了」，这里修了 14 处，按性质分组：

**会让功能失效的**

1. 弱匹配（只是字面像）没有标记，被当成强匹配返回
2. 渲染时把 `note` 吞掉——「只是字面接近，别硬套」的预警根本到不了模型
3. 过期清理（prune）那段引用了作用域外的 `state`，一旦真的有过期条目就抛 `ReferenceError`
4. 每日配额满后，按需采集也拿不到东西 → 新增 `demandBonus`

**并发与数据安全**

5. 定时采集与按需采集同时写 `state.json`，计数互相覆盖
6. 抓网络时一直占着状态锁，工具调用被堵几十秒 → 改成「短锁读 → 无锁抓 → 短锁写」
7. `state.json` / 语料重写改成**原子写**（临时文件 + rename），崩在中途不会留半截 JSON
8. 记需求的冷却表只增不减 → 只留最近 7 天、最多 200 条

**健壮性**

9. 采集失败只在控制台 warn，排查没依据 → 写 `state.lastError`
10. 语料读不出来时工具直接抛错 → 兜底成一句实话
11. `~\` 这种 Windows 写法不展开（会建出叫 `~` 的目录）
12. 工具异常没有兜底 / 重复挂载没有防护

**质量**

13. 标签规则太窄，覆盖率只有 13% → 扩到 23%（9 类场景）
14. `searchCorpus` 对未打标条目实时重打标，旧语料也跟着受益

---

## 开发

```bash
node --test     # 标签 / 检索 / 空池 / 弱匹配
```

---

## 致谢与许可

MIT。原始实现由原作者编写，经作者同意后在本仓库公开并维护。
本仓库在上游基础上修了上面列出的问题。
