# AnyToSheet（万物入表）

面向「飞书多维表格（一期） → WPS / Excel（二期）」的多端复用 AI 表格插件 Monorepo。

一期核心主打功能：**万能文件 / 截图 → 零配置精准入表（自动感知表头 + 浏览器端 PDF 逐页转高清图 + 一键读取飞书附件列 + 一文件拆多行 + 标黄校验复核）**。

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

### 4. 两种运行方式
- **本地浏览器直接预览**：访问 `http://localhost:5173`，自动进入模拟模式，可切换 3 套内置表头模板测试上传、标黄校验与写入全流程。
- **接入飞书多维表格真机联调**：打开任意飞书多维表格 → 右侧「插件」→「自定义插件」→ 填入 `http://localhost:5173`，即可实时读取当前真实表头并一键写入记录！
