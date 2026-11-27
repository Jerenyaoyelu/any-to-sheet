# AnyToSheet（万物入表）

面向「飞书多维表格（一期） → WPS / Excel（二期）」的多端复用 AI 表格插件 Monorepo。

四大核心能力（全部基于 `packages/core` 双端复用引擎）：
1. **万物入表**：图片 / 扫描版 PDF（浏览器本地转高清图）/ 飞书附件列 → 零配置感知表头 + 标黄复核写入。
2. **AI 脏数据一键清洗**：6 大本地零额度快捷清洗 + 自然语言 AI 生成安全声明式规则 + Git 式 Diff 预览 + 一键撤回。
3. **双表智能对账 / 找茬**：支持同文档另一张多维表格 / 粘贴 Excel / 上传 CSV，支持 AI 语义对齐列名、金额容差核对、高亮差异报告与 UTF-8 BOM CSV 导出。
4. **表格数据一键批量出交付物**：内置正式报价单、客户对账单、一客一单 Offer/通知书、自定义 `{{列名}}` 模板，支持实时 A4 排版预览、导出打印 PDF 与下载 Word (`.doc`) / HTML。

## 目录结构

```text
any-to-sheet/
├── packages/core/          # 纯 TS 核心层（动态 Schema、校验引擎、HostAdapter 接口）
├── apps/feishu-plugin/     # 飞书多维表格侧边栏插件（支持脱离飞书本地直接预览）
├── apps/server/            # 轻量后端（OpenAI 兼容多模态模型代理 + 内置 Mock 演示模式）
├── apps/wps-addin/         # 二期 WPS / Excel 加载项预留
└── docs/                   # 竞品分析、飞书上架/收费规则与成本测算
```

## 快速启动

### 1. 安装依赖并构建核心包
```bash
pnpm install
pnpm --filter @table-ai/core build
```

### 2. 配置后端环境变量（可选）
不配置也可以直接跑 **内置 Mock 演示模式**！如果要接入真实多模态大模型（通义千问 VL / 豆包视觉 / 硅基流动等）：
```bash
copy apps\server\.env.example apps\server\.env
# 编辑 apps\server\.env 填入 LLM_API_KEY
```

### 3. 启动前后端（两个终端分别执行）
```bash
# 终端 1：启动后端 (http://localhost:3001)
pnpm dev:server

# 终端 2：启动飞书插件前端 (http://localhost:5173)
pnpm dev:feishu
```

### 4. 三种访问入口
- **本地浏览器直接预览插件**：访问 `http://localhost:5173`，自动进入模拟模式，可切换 3 套内置表头模板测试上传、标黄校验与写入全流程。
- **接入飞书多维表格真机联调**：打开任意飞书多维表格 → 右侧「插件」→「自定义插件」→ 填入 `http://localhost:5173`，即可实时读取当前真实表头并一键写入记录！
- **轻量运营后台管理台**：访问 `http://localhost:3001/admin`（或 `http://localhost:5173/admin`），本地 Mock 模式默认密钥 `dev-admin-123`（上线配 `LLM_API_KEY` 后需在 `apps/server/.env` 中配置自定义 `ADMIN_TOKEN`），可查看用户/收入/毛利、批量发卡与作废激活码、手动给用户补发额度、查看最近提取流水。
