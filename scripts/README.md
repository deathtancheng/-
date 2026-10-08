# scripts/ —— 测试与运维脚本

| 文件 | 用途 |
| --- | --- |
| `smoke.js` | 后端冒烟：起服务 → 检查关键接口 |
| `smoke-frontend.sh` | 前端冒烟：起服务 → 拉所有前端模块 → 检查接口 |
| `shot-frontend.sh` | 无头截图：把界面各屏（迷宫 / 妖物场景 / 黑市场景 / 阁楼 / 夜战 / 更新日志）各拍一张，白屏和报错一眼看出来 |
| `stage.js` | 摆局面：直接调规则层把存档写成指定状态（站在妖物房上 / 在阁里 / 已入夜），给截图和无头验证一个稳定入口 |
| `check-imports.js` | 静态检查前端模块的 import/export 是否对得上 |
| `check-refs.js` | 静态扫 `src/`，找出「用到却没导入」的全大写常量（`node --check` 查不出这类） |
| `e2e.js` | Harness 端到端（给一句目标，看它调工具） |
| `e2e-v40.js` | v4 机制验证：迷宫 / 生存双条 / 香火 / 歇脚处 / 强制房间 / 营造 / 精怪 / 夜袭 / 周目重置 / 老存档兼容，80+ 条断言 |
| `game-auto.js` | 让 Harness 自己打通关的演示脚本 |
| `game-play.js` | 人类 playable 的 CLI 版本 |

> v3 的 `e2e-v31/32/33.js` 已随旧结构（五层楼 / 探索格）移除，
> 它们覆盖的机制（元素反应、架势、狂怒、道行）都并进了 `e2e-v40.js`。

## 运行方式

```bash
# v4 机制验证（不走网络、不走模型，毫秒级跑完）
node scripts/e2e-v40.js

# 冒烟测试
bash scripts/smoke-frontend.sh

# 无头截图（各屏各一张，落在 C:/temp/qs-shots/）
bash scripts/shot-frontend.sh

# 单独摆一个局面（截图 / 调试用；存档写进 sandbox/game/save.json）
node scripts/stage.js foe     # 站在妖物房上
node scripts/stage.js night   # 已入夜

# 静态导入检查
node scripts/check-imports.js

# 后端常量漏导入检查（改完 src/ 建议跑一次）
node scripts/check-refs.js
```

> 两个注意点：
> 1. 无头截图脚本必须在「起服务 + 截图」同一条命令里完成，
>    因为后台进程会随终端会话结束被回收。
> 2. `shot-frontend.sh` 里给接口塞 JSON 时别写 `"${2:-{}}"`——
>    bash 会多吐一个 `}` 出来，JSON 变非法，接口静默拿到空参数（踩过）。
