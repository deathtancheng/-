# src/harness/ —— 自研 Agent/Harness

手写 ReAct 循环 + 生命周期 + 扩展热插拔。

| 文件 | 职责 |
| --- | --- |
| `index.js` | 组装 Harness 实例 |
| `agent.js` | ReAct 主循环：模型调用 → 工具执行 → 上下文压缩 |
| `tools.js` | 工具注册、权限等级、执行器 |
| `builtin.js` | 内置工具：计算器、文件读写、时间、网络 fetch |
| `lifecycle.js` | 10 个钩子组成的生命周期，扩展可以挂事件 |
| `memory.js` | 长期记忆：把值得记的东西写进 `sandbox/memory/` |
| `provider.js` | 大模型 provider 封装，目前对接 Ollama |
| `context.js` | 运行时会话树、工具上下文 |
| `extensions.js` | 扩展加载器：扫描目录 → 注册工具/钩子/系统提示 |
| `extensions/quest.js` | 游戏扩展：把 Harness 变成《拾物奇谭》主持人 |
| `extensions/vision.js` | 视觉扩展：把摄像头检测当工具暴露给模型 |
| `extensions/research.js` | 科研扩展示例 |

## 扩展机制

一个扩展就是一段 CommonJS 模块，暴露：

- `name`：扩展名
- `SYSTEM`：给模型的系统提示片段
- `tools`：工具数组
- 可选：`onLoad/onUnload` 钩子

参考 `extensions/quest.js`。
