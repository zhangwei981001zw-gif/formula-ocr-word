# 公式识别 → Word / MathType

一个纯前端、无需 API Key 的公式 OCR 网页：

- 截图后直接 `Ctrl+V` 粘贴
- 上传 / 拖拽公式图片
- 浏览器本地 OCR，图片不上传到识别服务器
- 输出并可编辑 LaTeX
- 浏览器原生 MathML 预览
- 一键复制到 Word / MathType，同时提供 LaTeX / MathML 备用复制

## 在线使用

GitHub Pages 地址：

`https://zhangwei981001zw-gif.github.io/formula-ocr-word/`

备用预览地址：

`https://raw.githack.com/zhangwei981001zw-gif/formula-ocr-word/main/index.html`

## 工作方式

默认识别采用 [Texo / FormulaNet](https://github.com/alephpi/Texo)：支持时优先使用 WebGPU，GPU 初始化或推理失败时自动回退 CPU/WASM。首次需要下载快速模型（约 80 MB），后续通常由浏览器缓存。快速模式最长生成 256 个 token，避免异常重复解码浪费时间。

**精确识别（Texify2）只在手动点击时加载**，不会因为公式宽高比过大或快速识别结果异常自动下载 250–300 MB 模型。原有可编辑 LaTeX、MathML 预览及 Word/MathType 复制功能保持不变。

识别完成后的状态栏显示模型后端、推理耗时、必要时的模型加载耗时及总耗时。重复识别同一张图片不会再因为图像缓存 ArrayBuffer 被转移而失效。

如果仍然很慢，请先区分“下载/加载模型”与“推理”阶段；WebGPU 并不保证所有显卡或模型都比 CPU 快。

TeX → MathML 使用 [Temml](https://temml.org/)。

## 隐私

公式图片只在浏览器内进行预处理和推理，不发送到 Mathpix 或本项目自己的服务器。浏览器仍会从 CDN / Hugging Face 下载 JavaScript 库与开源模型文件。

## 许可与致谢

本项目使用的 FormulaNet / Texo 采用 GNU AGPL-3.0。为保持许可兼容，本项目源码同样按 **GNU AGPL-3.0-or-later** 提供。

- Texo / FormulaNet: Copyright © Sicheng Mao and contributors
- Transformers.js: Apache-2.0
- Temml: MIT

本项目按“现状”提供，不附带任何明示或暗示保证。
