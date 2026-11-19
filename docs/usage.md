# HaS 本地脱敏 — 使用说明

dsh-has 把 [HaS](https://huggingface.co/xuanwulab/HaS_Text_0209_0.6B_Q8)（Hide and Seek）文本脱敏引擎接进 DeepSeek Harness。
识别、替换、还原全部在本机的 `llama-server` + 0.6B GGUF 模型上完成，**原始文本不会离开这台机器**。

## 为什么需要它

把客户工单、病历、合同交给云端模型前，先把敏感实体换成可逆标签：

```text
客户张伟（手机 13800001111）反映收货地址写错。
        ↓ has_hide
客户<人名[1].姓名.全名>（手机 <电话号码[1].手机号.完整号码>）反映收货地址写错。
```

标签是 `<实体类型[ID].类别.属性>` 形式：

- 方括号里的 `[ID]` 是**同一实体**的编号，同一份文本里同一个真人/同一个地址编号一致；
- 云端模型看到的是标签，不理解真实值；
- 处理完用 `has_restore` + 本地 mapping 文件把标签换回真实值。

## 三个工具

| 工具 | 做什么 | 典型用法 |
| --- | --- | --- |
| `has_scan` | 只识别、不改写，返回每类实体数量 | 判断一份文档里到底有什么敏感信息 |
| `has_hide` | 改写成本地标签，保存 mapping 文件 | 脱敏后再把文本交给远程模型/服务 |
| `has_restore` | 用 mapping 把标签还原成真实值 | 远程结果回来后恢复 |
| `has_status` | 模型/服务是否就绪，服务启停 | 第一次使用前自检、排障 |

### 1. 先看一眼有什么（可选）

```json
{ "text": "客户张伟，手机 13800001111", "types": ["人名", "电话号码"] }
```

默认只回数量。确实要看具体值再加 `"reveal": true`（值会进入对话上下文，属于主动披露）。

### 2. 脱敏

文本输入：

```json
{ "text": "客户张伟，手机 13800001111", "types": ["人名", "电话号码"] }
```

返回改写后的 `text` 和 `mappingPath`（默认写到 `~/.dsh-has/mappings/hide-<时间>.mapping.json`，权限 0600）。
**mapping 文件不会回显**，它是还原全部明文的关键，请留在本机。

文件/目录输入（`path` 指向文件或目录，目录只处理第一层）默认输出到 `<目录>/.has/anonymized/`，
mapping 在 `<输出目录>/mappings/<文件名>.mapping.json`，只返回路径，不回显内容。

Word 文档（`.docx`）同样走 `path`：

```json
{ "path": "C:\\Users\\you\\Desktop\\合同.docx", "types": ["人名", "公司名", "电话号码", "地址"] }
```

它直接改文档内部的 XML，**样式、字体、版式都保留**，标签写进实体所在的同一个 run（文字片段）里，
因此不会被 Word 的排版冲散；表格、页眉、页脚、脚注都会被处理，图片和文本框保持原样。
还原时传 `.has/anonymized/` 里的那份 `path` 即可，输出落到 `.has/restored/`。

PDF（`.pdf`）也走 `path`：

```json
{ "path": "C:\\Users\\you\\Desktop\\报告.pdf", "types": ["人名", "公司名", "电话号码", "地址"] }
```

它先抽取文本（相邻的软换行会合并成段落，所以被折行的公司名仍能整体识别），脱敏后再重新排版成一份新 PDF：
页面尺寸和原文字号保持，标签绝不会被拆到两行，因此还原是确定性的。
代价是**输出是文本重排版本**——原 PDF 里的图片、表格线、矢量图形不会带过来，适合阅读版报告、公文、合同正文。
输出 PDF 内嵌一份中文 TrueType 字体（默认 `C:\Windows\Fonts\simhei.ttf`），因此文件约 5 MB；
找不到中文字体时会明确报错，提示安装字体或改写成 `.txt`。

长报告（几十上百页）通常不想重排版，加 `"pdfAsText": true` 只输出脱敏文本：

```json
{ "path": "C:\\Users\\you\\Desktop\\评审报告.pdf", "types": ["人名", "公司名", "电话号码"], "pdfAsText": true }
```

此时产物是 `.has/anonymized/<名字>.txt` + `mappings/<名字>.mapping.json`，图表和版式不带过来，
但每个字都在，速度也快得多（省掉了重排和 5 MB 字体）。还原时把该 `.txt` 和 mapping 传回来、
同样带 `"pdfAsText": true`，输出 `.has/restored/<名字>.txt`。

### 3. 还原

把（可能已被远程模型处理过的）带标签文本 + 同一个 `mappingPath` 传回来：

```json
{ "text": "客户<人名[1].姓名.全名>，手机 <电话号码[1].手机号.完整号码>", "mappingPath": "C:\\Users\\you\\.dsh-has\\mappings\\hide-2026-....mapping.json" }
```

还原优先用确定性替换（Tool-Seek）；只有标签被改写、或文本被翻译成另一种语言时才调用本地模型（Model-Seek），
并按句子边界分块，绝不切断一个标签。

## `types` 怎么写

`types` 是开放集合，写你真正想隐藏的东西，**语言必须和文本一致**：

- 中文文本：`["人名", "电话号码", "身份证号", "地址", "电子邮箱", "银行卡号"]`
- 英文文本：`["person name", "phone number", "address", "email address"]`

用词会影响效果：`personal location` 和 `location` 不是一回事；类型越贴近实际内容，召回越稳。
支持中/英/法/德/西/葡/日/韩及混排文本。

## 速度和长文档

0.6B 模型在本机跑，吞吐取决于机器：纯 CPU 的 `llama-server` 构建大约 15 token/s，
一段 2000 token 的工单脱敏约需 2～3 分钟；换 CUDA / Metal 版 `llama-server` 会快一个数量级。
长文档按块串行处理，块越大，重复送给模型的上下文越少、总耗时越低。

想自己控制块大小（例如单块更快出结果、更省内存）时，可在 `has_hide` / `has_scan` / `has_restore`
上传 `"maxChunkTokens": 1500`；不传就用上面的默认值。

## 隐私边界

- 所有推理都在 `127.0.0.1` 的本地 `llama-server` 上；插件拒绝非回环地址。
- 模型只在第一次使用时加载（约数秒），之后复用；空闲 30 分钟自动卸载释放内存。
- mapping 文件按 0600 权限写入（Windows 上为尽力而为），包含可逆明文，等同密钥。
- `has_scan` 默认只回计数、`has_restore` 处理文件时默认只回路径，都是为了避免明文重新进入模型上下文。

## 配置

优先级：环境变量 > `cordis.patch.yml` 里的行配置 > `~/.dsh-has/config.json` > 默认值。

| 配置 | 环境变量 | 默认 |
| --- | --- | --- |
| 模型路径 | `HAS_TEXT_MODEL_PATH` | 自动查找 `~/.dsh-has/models/`、`~/.openclaw/tools/has-anonymizer/models/` 等 |
| llama-server | `HAS_LLAMA_SERVER` | PATH + WinGet/llama.cpp 常见安装位置 |
| 状态目录 | `DSH_HAS_HOME` | `~/.dsh-has` |
| 每槽上下文 | `DSH_HAS_CONTEXT_PER_SLOT` | `8192` |
| 并发槽位上限 | `DSH_HAS_MAX_SLOTS` | `4` |
| 并发请求 | `HAS_TEXT_MAX_PARALLEL_REQUESTS` | `4` |
| 单块 token 上限 | — | `3000`（扫描 `5000`） |
| 空闲卸载 | `DSH_HAS_IDLE_TIMEOUT_MS` | `1800000` |
| 关闭 diff 配对 | `DSH_HAS_TOOL_PAIR` | `true`（开启） |
| 标签使用约定写入系统提示 | `DSH_HAS_GUIDANCE` | `false`（开启会给每个会话的提示词加约 60 个 token） |

模型下载（约 640 MB）：HuggingFace `xuanwulab/HaS_Text_0209_0.6B_Q8`，或 ModelScope `TencentXuanwu/HaS_Text_0209_0.6B_Q8`，
放到 `~/.dsh-has/models/has_text_model.gguf`。
`llama-server` 可用 `winget install ggml.llamacpp` 安装。

## 常见问题

- **`has_status` 显示 NOT ready**：缺模型或缺 `llama-server`，按上一节放好即可，无需重启 DSH。
- **`no longer leaves room`**：累积 mapping 太大，单块预算不够。拆小文档，或提高 `contextPerSlot`。
- **`Generation exceeded the 180s request budget`**：这一块生成太久（长文本或机器较慢）。插件会自动把它当成
  “块太大”重试一次，用更小的块再跑；仍失败就调小 `maxChunkTokens` 或换更快的 `llama-server` 构建。
- **`Cross-language seek could not be chunked safely`**：远程模型改坏了标签。让它原样保留 `<...>` 标签，
  再试 `has_restore`，或在还原前把标签修回原样。
- **服务端口被占用**：会自动挑一个空闲端口，`has_status` 里能看到实际端口。
- **还原后首尾空行/换行丢了**：0.1.0 已修（首尾空白会原样保留）。若用旧版本产生的 mapping，重新脱敏即可。
- **还原后少了个别标点（例如 markdown 的 `[` `]`）**：0.6B 模型改写时可能顺手删掉包住实体的标点。
  这类字符在脱敏文本里已经不存在，任何 mapping 都无法还原。小模型有随机性，重跑一次 `has_hide` 往往就能保住；
  需要逐字节一致时，用 `npm run test:roundtrip -- <文件> --types 人名,地址` 验证一遍再交出去。
- **PDF 出来的图和表格丢了**：输出是“文本重排版”PDF，只为保留可读文字和字号/页宽；图片、表格线、矢量图不搬运。
  需要原样版式时，请用 `.docx` 原文件脱敏。
- **`No embeddable CJK font was found`**：机器上找不到可嵌入的中文 TrueType 字体。装一个（例如拷入 `C:\Windows\Fonts\simhei.ttf`）
  或用 `has_hide` 处理同名 `.txt` 文本后自己排版。
- **别的阅读器打不开生成的 PDF**：0.1.x 早期版本的文件头少了一行 `%PDF-1.4`，多数阅读器会直接拒绝；
  已修复并加了回归测试（`npm test` 里的 “pdf writer emits a structurally valid document”）。
  需要复核某个输出文件时，在 Windows 上跑
  `powershell -ExecutionPolicy Bypass -File test/validate-pdf.ps1 -Render <文件.pdf>`，它会用系统 PDF 引擎加载并渲染首页。
- **PDF 扫描件没识别出实体**：纯图片扫描件没有文字层，本插件不做 OCR，请先 OCR 成文本 PDF 或 `.txt`。
- **图片脱敏呢**：上游 skill 还有 `has image` 系列，但需要单独的 `sensitive_seg_best.pt` 检测模型，本插件未包含。目前只做文本、Word 和 PDF。
- **Word 里少还原了某段文字**：段落里如果有文本框、艺术字或域代码，模型看不到那部分文本，标签也没法落进去；
  这类内容请先转成普通正文再脱敏。段落内标签无法对齐到具体 run 时会退化为“整段一个 run”并给出 warn 日志，文字仍然正确。
- **换模型后不生效**：执行一次 `has_status` 的 `action: "stop"`，下次调用会按新配置重启。

## 给模型的使用约定

把脱敏文本交给远端时，附带一句约定，可显著降低标签被改写的概率：

> 文本中的 `<类型[ID].类别.属性>` 是脱敏标签：请逐字保留，不要翻译、不要改 ID、不要猜测或补全真实值。
