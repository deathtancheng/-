# src/vision/ —— 视觉检测

封装 YOLO 推理，供后端调用。

| 文件 | 职责 |
| --- | --- |
| `detect.js` | 调用摄像头常驻服务 `camera_server.py` 取检测结果，解析并返回统一格式 |

## 运行方式

YOLO 常驻推理由 `camera_server.py`（项目根目录）负责启动。
它监听 `http://127.0.0.1:5179`，`detect.js` 通过普通 HTTP GET 拿到当前帧检测结果。

```bash
# 启动摄像头服务
python camera_server.py
```

详见项目根目录 `README.md` 的「启动方式」一节。
