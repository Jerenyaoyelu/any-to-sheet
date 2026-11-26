# WPS / Excel 加载项端（二期预留）

本目录用于二期复用 `@table-ai/core` 开发 **WPS 表格加载项（JS Add-in）** 与 **Microsoft Excel Add-in**。

## 复用方式

只需实现 `@table-ai/core` 中的 `HostAdapter` 接口（约 150 行代码）：
- `getActiveTableSchema()`: 通过 `Application.ActiveSheet` 读取当前选区/表头行与前 3 行样例。
- `writeValidatedRows()`: 将经过 `@table-ai/core` 校验的预览结果直接批量写入当前工作表。

此外，二期可在 `packages/core` 中新增：
1. **公式 AST 报错体检引擎**：追踪引用链、识别文本型数字 / 隐藏空格 / 引用断裂。
2. **自然语言 → 本地 JS 清洗脚本 + Git 式 Diff 预览与回滚**。
