# src/http/ —— HTTP 服务层

把网络请求路由到对应业务模块。主程序只认识 `router.js`，加接口不用改入口。

| 文件 | 职责 |
| --- | --- |
| `server.js` | 创建 Node 原生 HTTP server，统一兜异常 |
| `router.js` | 路由分发，所有路由返回 `boolean` |
| `context.js` | 请求级共享状态：`gameRun`、`confirmSeq` 等 |
| `static.js` | 静态资源托管：`public/` 下的 HTML/CSS/JS/图片 |
| `util.js` | 小工具：`sendJson`、`readBody`、MIME 表 |
| `routes/game.js` | `/api/game/*`：局面、献祭、放咒、探索、重开 |
| `routes/stream.js` | `/api/game/stream`：SSE 局面推送 |
| `routes/vision.js` | `/api/camera/*`：摄像头画面、YOLO 检测 |
| `routes/agent.js` | `/api/chat`、`/api/harness/*`：通用智能体对话 |

## 路由约定

每个路由模块导出一个函数：

```js
async function handle(req, res, url, ctx) { return boolean; }
```

- 返回 `true`：已处理，不要再传。
- 返回 `false`：不是我这儿的，继续下一个。

这样新增接口只需新增一个文件并把它加到 `router.js` 的 `ROUTES` 数组。
