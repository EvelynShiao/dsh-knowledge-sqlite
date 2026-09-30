# dsh-knowledge-sqlite（中文增强版）

DeepSeek Harness 的跨会话知识库插件。本仓库在上游 `dsh-knowledge-sqlite` v0.1.9 基础上加了三个补丁，
解决中文实际使用中的三个硬伤。

上游：https://github.com/NinjaSln-labs/dsh-knowledge-sqlite （npm 包名同名）

---

## 补丁 1：短词检索（原来 1~2 字的中文完全搜不到）

上游用 FTS5 **trigram** 分词，任何查询都要切成「三字一组」才能命中索引。于是：

| 查询 | 上游 | 本版 |
|---|---|---|
| 薛定谔（3 字） | 命中 | 命中 |
| 量子（2 字） | 0 条 | 命中 |
| 红楼（2 字） | 0 条 | 命中 |
| 猫（1 字） | 0 条 | 命中 |

中文两字词极多（量子、物理、光遇、偏好、记忆……），上游对它们等于全盲。

**修法**：trigram 主路照跑；当查询切不出 gram、或长度不超过 8 字时，
补一条子串扫描（`LIKE`）把漏掉的命中找回来，再按「相关度在前、子串在后」合并去重。
本地知识库规模小，这个开销可以接受。

## 补丁 2：标签目录树（图书馆式逐层翻阅）

上游能写入标签，但**检索工具不支持按标签过滤**，也没有「列出目录」的能力。

本版新增 **`knowledge_tags`** 工具。标签按 `/` 当路径分隔符
（例如 `自然科学/物理/量子科学`），可以一层层往下翻：

```
knowledge_tags()                          -> 文学(2)  自然科学(2)  游戏(1)
knowledge_tags(prefix: "文学")             -> 文学/中国古典小说(2)
knowledge_tags(prefix: "自然科学/物理")     -> 自然科学/物理/光学(1)  自然科学/物理/量子科学(1)
```

同时 **`knowledge_search`** 和 **`knowledge_list`** 新增 `tags` 参数。
过滤语义是**包含子路径**：传 `自然科学/物理` 会一并命中挂在
`自然科学/物理/光学` 下的条目。

`knowledge_list` 的返回里也补上了 `tags` 字段（上游漏了）。

## 补丁 3：写入门控默认关闭

上游默认 `gating: `'`ask`'`，每次写入都要人工点确认。
当 DSH 的审批策略是 `never` 时，ask 门控会被**自动拒绝**，知识库根本写不进去。

本版把 `cordis.patch.yml` 里的 `gating` 改成 `'none'`。
若希望写入需要确认，改回 `'ask'` 即可。

---

## 安装

```powershell
.\install.ps1
# 或指定 DSH 配置目录
.\install.ps1 -DshHome "D:\somewhere\.dsh"
```

装完**重启 DSH**（刷新网页不够，要让宿主进程重载插件）。

不用脚本的话，手动把 `lib`、`package.json`、`cordis.patch.yml` 覆盖到：

```
<DSH_HOME>\profiles\web\node_modules\dsh-knowledge-sqlite\
```

## 提供的工具

| 工具 | 作用 |
|---|---|
| `knowledge_write` | 写入一条知识，立即入索引，零 LLM |
| `knowledge_search` | 检索。`query` + 可选 `tags` + 可选查询扩展 |
| `knowledge_list` | 列出/审计，带 `tags` 过滤与返回 |
| `knowledge_tags` | **（新增）** 浏览标签目录树 |
| `knowledge_update` | 修正条目 |
| `knowledge_delete` | 删除（墓碑） |
| `knowledge_probe` | 上游自带的评测套件 |

## 存储

单个 SQLite 文件，默认 `<DSH_HOME>/knowledge.sqlite`。
`items` 表 + 两张 FTS5 trigram 表（正文 / 正文+富化字段），`tags` 列存 JSON 数组。

---

## 升级提醒

补丁直接改在 `node_modules` 里。**上游发新版或 DSH 重装插件会覆盖它们**，
重跑本仓库的 `install.ps1` 即可再次打上。

## License

MIT（继承上游）。
